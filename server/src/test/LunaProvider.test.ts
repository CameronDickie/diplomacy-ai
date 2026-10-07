import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Power } from '@diplomacy/shared';
import { Store,hashToken } from '../storage/Store.js';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { challengeDefinition } from '../fixtures/ScenarioFixture.js';
import { AttemptService } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { LunaDecisionProvider } from '../luna/LunaDecisionProvider.js';
import { httpLunaTransport,mockLunaTransport,type LunaTransport } from '../luna/Transport.js';
import { LUNA_PRESET,buildLunaRequest,lunaReservationNanousd } from '../providers/LunaPreset.js';

const OPPONENTS:Power[]=['AUSTRIA','ENGLAND','FRANCE','GERMANY','ITALY','RUSSIA'];
const powerOf=(body:string)=>/You are ([A-Z]+)\./.exec(body)![1] as Power;
async function setup(t:test.TestContext,granted=1_000_000_000,fixtureName='tunis-expedition'){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-luna-provider-')),path=join(dir,'game.sqlite');let now=1_800_000_000_000;
  let store=await Store.open(path);
  const fixture=JSON.parse(await readFile(new URL(`../../fixtures/development/${fixtureName}.v1.json`,import.meta.url),'utf8'));
  const content={definition:challengeDefinition(fixture)!,board:fixture.board};
  await store.call('registerChallenge',{...content,hash:createHash('sha256').update(canonicalJson(content)).digest('hex'),now});
  if(granted)await store.call('grantFunding',{amountNanousd:granted,authorizationRef:'test-grant-0001',grantedBy:'test',now});
  const player=await store.call('identity',{provider:'github',subject:'luna',displayName:'Test',now});
  const attempt=await store.call('createAttempt',{id:'sponsored',playerId:player.id,challengeId:fixtureName,challengeVersion:1,reconnectTokenHash:hashToken('t'),now});
  const rules=new PhaseRules();
  const humanIds=(await rules.legal(attempt.board,content.definition.humanPower,new AbortController().signal)).filter(o=>o.order.type==='MOVE').slice(0,1).map(o=>o.id);
  const holdIds=(await rules.legal(attempt.board,content.definition.humanPower,new AbortController().signal)).filter(o=>o.order.type==='HOLD'&&!humanIds.some(id=>id.startsWith(`${o.unitTerritory}|`))).map(o=>o.id);
  const command={attemptId:attempt.id,playerId:player.id,revision:0,phaseId:attempt.phaseId,requestId:'orders-1',action:{phase:'ORDERS' as const,orderIds:[...humanIds,...holdIds]}};
  const sent:Array<{power:Power;body:string}>=[];
  /** A transport that records what was sent and lets a test script each power's answer. */
  const scripted=(script:(power:Power,request:Parameters<LunaTransport>[0],n:number)=>ReturnType<LunaTransport>|null=()=>null):LunaTransport=>{
    const mock=mockLunaTransport({pick:'seeded',seed:7});
    return async request=>{const power=powerOf(request.body);sent.push({power,body:request.body});return await script(power,request,sent.filter(s=>s.power===power).length)??mock(request);};
  };
  const services:AttemptService[]=[];
  const service=(transport:LunaTransport,options:ConstructorParameters<typeof LunaDecisionProvider>[3]={},serial=true)=>{
    const s=new AttemptService(store,new LunaDecisionProvider(store,rules,transport,{now:()=>now,...(serial?{maxConcurrentDecisions:1}:{}),...options}),rules,{now:()=>now});services.push(s);return s;
  };
  const sql=<T>(work:(db:DatabaseSync)=>T)=>{const db=new DatabaseSync(path,{readOnly:true});try{return work(db);}finally{db.close();}};
  const ledger=async()=>{const x=await store.call('fundingTotals',{});return {settled:x.settledNanousd,reserved:x.reservedNanousd,unknown:x.unknownLiabilityNanousd};};
  const billed=()=>sql(db=>Number(db.prepare("SELECT COALESCE(sum(json_extract(usage_json,'$.costNanousd')),0) n FROM provider_calls").get()!.n));
  const calls=(where='1=1')=>sql(db=>db.prepare(`SELECT id,state,outcome FROM provider_calls WHERE ${where} ORDER BY id`).all().map(r=>`${String(r.id).split(':').slice(1).join(':')} ${r.state} ${r.outcome??'-'}`));
  t.after(async()=>{await Promise.all(services.map(s=>s.close()));await store.close();await rm(dir,{recursive:true,force:true});});
  const operation=()=>sql(db=>String(db.prepare('SELECT id FROM phase_jobs ORDER BY created_at LIMIT 1').get()!.id));
  return {dir,path,player,attempt,command,rules,sent,scripted,service,sql,ledger,billed,calls,operation,humanIds,get store(){return store;},now:()=>now,
    current:()=>store.call('attempt',{id:attempt.id}),reports:()=>store.call('reports',{attemptId:attempt.id}),
    async reopen(){await Promise.all(services.splice(0).map(s=>s.close()));await store.close();store=await Store.open(path);}};
}
const completed=(text:string,id:string,input=500,output=40)=>({status:200,body:{id,model:LUNA_PRESET.model,service_tier:LUNA_PRESET.serviceTier,status:'completed',error:null,
  usage:{input_tokens:input,output_tokens:output,total_tokens:input+output,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:0}},
  output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]}});

test('a sponsored phase makes one reserved, settled call per opponent, commits their choices and never sends the human\'s orders',async t=>{
  const f=await setup(t),service=f.service(f.scripted());
  await service.submit(f.command);await service.wait(f.attempt.id);
  const after=(await f.current())!;
  assert.deepEqual([after.board.season,after.execution,after.lifecycle],['FALL','ACCEPTING','ACTIVE']);
  assert.deepEqual(f.sent.map(s=>s.power),OPPONENTS);
  assert.deepEqual(f.calls(),OPPONENTS.map(p=>`${p}:1 FINISHED VALID`));
  const ledger=await f.ledger();
  assert.equal(ledger.settled,f.billed());assert.ok(ledger.settled>0);assert.deepEqual([ledger.reserved,ledger.unknown],[0,0]);
  // The opponents actually moved: the seeded mock does not just hold.
  const [report]=await f.reports();assert.equal(report.phase,'ORDERS');
  assert.ok(report.phase==='ORDERS'&&report.resolvedOrders.some(o=>o.power!=='TURKEY'&&o.type!=='HOLD'));
  // No request carried the human's submitted move, and each carried only its own power's options.
  const humanMove=(await f.rules.legal(f.attempt.board,'TURKEY',new AbortController().signal)).find(o=>o.id===f.humanIds[0])!.description;
  for(const {body} of f.sent){assert.ok(!body.includes(humanMove)&&!body.includes(f.humanIds[0]),humanMove);assert.equal(JSON.parse(body).model,'gpt-6-luna');}
  assert.equal((await f.store.call('providerDecisions',{operationId:f.operation()})).length,6);
});

test('running out of budget mid-phase pauses paid play, leaves the phase recoverable and never substitutes holds; a grant resumes without re-buying',async t=>{
  // One worst-case reservation fits; after a few real bills there is no longer room for another.
  const f=await setup(t,5_260_000),service=f.service(f.scripted());
  await service.submit(f.command);await service.wait(f.attempt.id);
  let state=(await f.current())!;
  assert.deepEqual([state.board.season,state.execution],['SPRING','RECOVERING']);
  assert.equal((await f.reports()).length,0);
  const bought=f.sent.length;assert.ok(bought>=1&&bought<6,String(bought));
  assert.equal((await f.store.call('paidState',{})).stopped,true);
  assert.equal((await f.store.call('providerDecisions',{operationId:f.operation()})).length,bought);
  // Recovering while still out of funds buys nothing and changes nothing.
  await service.recover(f.attempt.id);await service.wait(f.attempt.id);
  assert.equal(f.sent.length,bought);assert.equal((await f.current())!.execution,'RECOVERING');
  await f.store.call('grantFunding',{amountNanousd:50_000_000,authorizationRef:'owner-ref-0002',grantedBy:'test',now:f.now()});
  await service.recover(f.attempt.id);await service.wait(f.attempt.id);
  assert.equal(f.sent.length,bought);
  await f.store.call('setPaidStopped',{stopped:false,operatorId:'owner',now:f.now()});
  await service.recover(f.attempt.id);await service.wait(f.attempt.id);
  state=(await f.current())!;
  assert.deepEqual([state.board.season,state.execution],['FALL','ACCEPTING']);
  // Exactly the missing powers were asked: six answers bought in total, none twice.
  assert.deepEqual(f.sent.map(s=>s.power),OPPONENTS);
  assert.equal((await f.ledger()).settled,f.billed());assert.equal((await f.reports()).length,1);
});

test('a billed but unusable answer is kept on the books, stops the phase, and only that power is asked again on recovery',async t=>{
  const f=await setup(t);
  const service=f.service(f.scripted((power,_request,n)=>power!=='FRANCE'?null:n===1?Promise.resolve(completed('this is not json','resp_bad_1')):n===2?Promise.resolve(completed('{"choices":[0,0,0]}','resp_bad_2')):null),{maxCallsPerPower:3});
  await service.submit(f.command);await service.wait(f.attempt.id);
  assert.equal((await f.current())!.execution,'RECOVERING');
  assert.deepEqual(f.sent.map(s=>s.power),['AUSTRIA','ENGLAND','FRANCE']);
  assert.deepEqual(f.calls("id LIKE '%FRANCE%'"),['FRANCE:1 FINISHED INVALID_JSON']);
  const afterFirst=(await f.ledger()).settled;assert.equal(afterFirst,f.billed());
  await service.recover(f.attempt.id);await service.wait(f.attempt.id);
  // Second answer names one unit three times: also billed, also refused.
  assert.deepEqual(f.calls("id LIKE '%FRANCE%'"),['FRANCE:1 FINISHED INVALID_JSON','FRANCE:2 FINISHED INVALID_ACTION']);
  assert.equal((await f.current())!.execution,'RECOVERING');assert.ok((await f.ledger()).settled>afterFirst);
  await service.recover(f.attempt.id);await service.wait(f.attempt.id);
  assert.deepEqual([(await f.current())!.board.season,(await f.current())!.execution],['FALL','ACCEPTING']);
  assert.deepEqual(f.sent.map(s=>s.power),['AUSTRIA','ENGLAND','FRANCE','FRANCE','FRANCE','GERMANY','ITALY','RUSSIA']);
  assert.equal((await f.ledger()).settled,f.billed());
});

test('a token-count outage buys nothing and uses none of the call limit: the phase completes once the count endpoint is back',async t=>{
  const f=await setup(t),mock=mockLunaTransport();let outage=true,counts=0,models=0;
  const transport=(async()=>{throw new Error('dispatch requires preflight');}) as LunaTransport;
  transport.preflight=async()=>{counts++;if(outage)throw new Error('count endpoint unavailable');return {inputTokens:600,send:async request=>{models++;return mock(request);}};};
  const service=f.service(transport);
  await service.submit(f.command);await service.wait(f.attempt.id);
  // More failed preflights than the per-power call limit of three.
  for(let i=0;i<4;i++){await service.recover(f.attempt.id);await service.wait(f.attempt.id);}
  assert.deepEqual([counts,models,(await f.current())!.execution],[5,0,'RECOVERING']);
  assert.deepEqual(await f.ledger(),{settled:0,reserved:0,unknown:0});
  assert.ok(f.calls().every(c=>c.endsWith('FINISHED CANCELLED')));
  outage=false;await service.recover(f.attempt.id);await service.wait(f.attempt.id);
  assert.deepEqual([(await f.current())!.board.season,(await f.current())!.execution,models],['FALL','ACCEPTING',6]);
  assert.equal(f.calls().filter(c=>c.endsWith('FINISHED VALID')).length,6);
  assert.equal((await f.ledger()).settled,f.billed());
});

test('the per-power call limit ends retries: the phase stays recoverable and nothing more is dispatched',async t=>{
  const f=await setup(t),service=f.service(f.scripted(power=>power==='AUSTRIA'?Promise.resolve(completed('{}','resp_'+Math.random().toString(36).slice(2))):null),{maxCallsPerPower:2});
  await service.submit(f.command);await service.wait(f.attempt.id);
  for(let i=0;i<3;i++){await service.recover(f.attempt.id);await service.wait(f.attempt.id);}
  assert.equal(f.sent.length,2);
  assert.deepEqual(f.calls(),['AUSTRIA:1 FINISHED INVALID_ACTION','AUSTRIA:2 FINISHED INVALID_ACTION']);
  assert.deepEqual([(await f.current())!.execution,(await f.reports()).length],['RECOVERING',0]);
  // The player can still close the attempt; its costs stay recorded.
  await service.terminate(f.attempt.id,f.player.id,'ABANDONED');
  assert.equal((await f.current())!.lifecycle,'ABANDONED');assert.equal((await f.ledger()).settled,f.billed());
});

test('an answer that never arrives keeps its reservation; recovery buys a new call and a late bill still settles the old one',async t=>{
  const f=await setup(t);let hang=true;
  const service=f.service(f.scripted((power,request)=>power==='ENGLAND'&&hang?new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})):null),{timeoutMs:500});
  await service.submit(f.command);await service.wait(f.attempt.id);
  assert.equal((await f.current())!.execution,'RECOVERING');
  assert.deepEqual(f.calls("id LIKE '%ENGLAND%'"),['ENGLAND:1 FINISHED TIMEOUT']);
  const held=await f.ledger();assert.ok(held.unknown>0);assert.equal(held.reserved,0);
  // The short deadline tests the hung call, not successful worker/Godip speed.
  hang=false;const recovery=f.service(f.scripted());
  await recovery.recover(f.attempt.id);await recovery.wait(f.attempt.id);
  assert.equal((await f.current())!.board.season,'FALL');
  assert.deepEqual(f.calls("id LIKE '%ENGLAND%'"),['ENGLAND:1 FINISHED TIMEOUT','ENGLAND:2 FINISHED VALID']);
  // The phase is committed, yet the first call's worst case is still held until its bill is known.
  assert.equal((await f.ledger()).unknown,held.unknown);
  const lateId=f.sql(db=>String(db.prepare("SELECT id FROM provider_calls WHERE outcome='TIMEOUT'").get()!.id)),before=(await f.ledger()).settled;
  await f.store.call('receiveProviderCall',{id:lateId,responseId:'resp_late',usage:{inputTokens:600,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:30,reasoningTokens:0,costNanousd:75_000},now:f.now()});
  assert.deepEqual(await f.ledger(),{settled:before+75_000,reserved:0,unknown:0});
  assert.equal((await f.reports()).length,1);
});

test('an operator stop, a ban or an abandon during a decision ends spending and fences the late answer without losing its bill',async t=>{
  for(const action of ['stop','ban','abandon'] as const){
    const f=await setup(t);let release!:()=>void,reached!:()=>void;const waiting=new Promise<void>(done=>{reached=done;});
    const mock=mockLunaTransport();
    const service=f.service(f.scripted((power,request)=>power!=='FRANCE'?null:new Promise(resolve=>{reached();release=()=>resolve(mock(request));})));
    await service.submit(f.command);await waiting;
    if(action==='stop')await f.store.call('setPaidStopped',{stopped:true,operatorId:'owner',now:f.now()});
    else if(action==='ban')await service.banPlayer(f.player.id);
    else await service.terminate(f.attempt.id,f.player.id,'ABANDONED');
    release();await service.wait(f.attempt.id);
    const state=(await f.current())!;
    // A stop lets the in-flight call finish but admits no further one; ban and abandon close the attempt.
    if(action==='stop'){
      assert.deepEqual([state.lifecycle,state.execution],['ACTIVE','RECOVERING'],action);
      assert.deepEqual(f.sent.map(s=>s.power),['AUSTRIA','ENGLAND','FRANCE'],action);
      assert.deepEqual(f.calls("id LIKE '%FRANCE%'"),['FRANCE:1 FINISHED VALID'],action);
    } else {
      assert.notEqual(state.lifecycle,'ACTIVE',action);assert.deepEqual(f.sent.map(s=>s.power),['AUSTRIA','ENGLAND','FRANCE'],action);
      // The in-flight call was cancelled from the game's point of view; its reservation is still held.
      assert.deepEqual(f.calls("id LIKE '%FRANCE%'"),['FRANCE:1 FINISHED CANCELLED'],action);
      assert.ok((await f.ledger()).unknown>0,action);
    }
    assert.equal((await f.reports()).length,0,action);assert.equal(state.board.season,'SPRING',action);
    assert.equal((await f.ledger()).settled,f.billed(),action);
    await service.recover(f.attempt.id);await service.wait(f.attempt.id);
    assert.equal(f.sent.length,3,action);
  }
});

test('retreat and adjustment phases call only the powers that have something to decide',async t=>{
  for(const [name,expected] of [['retreat-position',1],['winter-build',1]] as const){
    const dir=await mkdtemp(join(tmpdir(),'diplomacy-luna-phase-')),store=await Store.open(join(dir,'game.sqlite')),now=1_800_000_000_000;
    t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
    const raw=JSON.parse(await readFile(new URL(`../../fixtures/development/${name}.v1.json`,import.meta.url),'utf8'));
    // The human plays a power with nothing to do this phase, so every acting power is an opponent.
    raw.objective={humanPower:'TURKEY',territory:'TUN',deadlineYear:1905,earlyAchievementYear:1902};
    const {importScenario}=await import('../fixtures/ScenarioFixture.js'),fixture=await importScenario(raw),content={definition:challengeDefinition(fixture)!,board:fixture.board};
    await store.call('registerChallenge',{...content,hash:createHash('sha256').update(canonicalJson(content)).digest('hex'),now});
    await store.call('grantFunding',{amountNanousd:1_000_000_000,authorizationRef:'test-grant-0001',grantedBy:'test',now});
    const player=await store.call('identity',{provider:'github',subject:'phase',displayName:'Test',now});
    const attempt=await store.call('createAttempt',{id:'phase',playerId:player.id,challengeId:name,challengeVersion:1,reconnectTokenHash:hashToken('t'),now});
    const sent:string[]=[],mock=mockLunaTransport(),rules=new PhaseRules();
    const service=new AttemptService(store,new LunaDecisionProvider(store,rules,async request=>{sent.push(powerOf(request.body));return mock(request);},{now:()=>now}),rules,{now:()=>now});
    t.after(()=>service.close());
    const action=attempt.board.phase==='RETREATS'?{phase:'RETREATS' as const,retreats:{}}:{phase:'BUILDS' as const,builds:[],disbands:[]};
    await service.submit({attemptId:attempt.id,playerId:player.id,revision:0,phaseId:attempt.phaseId,requestId:'r',action});await service.wait(attempt.id);
    const after=(await store.call('attempt',{id:attempt.id}))!;
    assert.equal(after.execution,after.lifecycle==='ACTIVE'?'ACCEPTING':'IDLE',name);assert.notEqual(after.phaseId,attempt.phaseId,name);
    assert.equal(sent.length,expected,`${name}: ${sent.join()}`);
  }
});

test('a process killed anywhere in a sponsored phase recovers to exactly one report without paying twice for a saved answer',async t=>{
  const expected={RESERVED:{asked:['GERMANY','ITALY','RUSSIA'],germany:['GERMANY:1 FINISHED CANCELLED','GERMANY:2 FINISHED VALID'],unknown:false},
    COUNTING:{asked:['GERMANY','ITALY','RUSSIA'],germany:['GERMANY:1 FINISHED CANCELLED','GERMANY:2 FINISHED VALID'],unknown:false},
    COUNTED:{asked:['GERMANY','ITALY','RUSSIA'],germany:['GERMANY:1 FINISHED CANCELLED','GERMANY:2 FINISHED VALID'],unknown:false},
    DISPATCHED:{asked:['GERMANY','ITALY','RUSSIA'],germany:['GERMANY:1 FINISHED TRANSPORT_ERROR','GERMANY:2 FINISHED VALID'],unknown:true},
    RECEIVED:{asked:['GERMANY','ITALY','RUSSIA'],germany:['GERMANY:1 RECEIVED -','GERMANY:2 FINISHED VALID'],unknown:false},
    DECIDED:{asked:['ITALY','RUSSIA'],germany:['GERMANY:1 FINISHED VALID'],unknown:false},
    ALL_DECIDED:{asked:[],germany:['GERMANY:1 FINISHED VALID'],unknown:false},
    COMMITTED:{asked:[],germany:['GERMANY:1 FINISHED VALID'],unknown:false}} as const;
  for(const stage of Object.keys(expected) as Array<keyof typeof expected>){
    const f=await setup(t);
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/crashLuna.js',import.meta.url)),f.path,stage,JSON.stringify(f.command)],{stdio:'ignore',env:{PATH:process.env.PATH}});
    const [code,signal]=await once(child,'exit');assert.equal(code,null,stage);assert.equal(signal,'SIGKILL',stage);
    await f.reopen();
    const counted:Power[]=[],mock=f.scripted();
    const recovered=['COUNTING','COUNTED'].includes(stage)?httpLunaTransport('test-key-not-real',(async(url,init)=>{
      if(String(url)===LUNA_PRESET.countEndpoint){counted.push(powerOf(String(init!.body)));return new Response('{"object":"response.input_tokens","input_tokens":100}');}
      const result=await mock({body:String(init!.body),signal:init!.signal as AbortSignal});return new Response(JSON.stringify(result.body));
    }) as typeof fetch):mock;
    const service=f.service(recovered);
    await service.recover();await service.wait(f.attempt.id);
    const state=(await f.current())!;
    assert.deepEqual([state.board.season,state.execution,state.lifecycle],['FALL','ACCEPTING','ACTIVE'],stage);
    assert.equal((await f.reports()).length,1,stage);
    assert.deepEqual(f.sent.map(s=>s.power),expected[stage].asked,stage);
    if(['COUNTING','COUNTED'].includes(stage))assert.deepEqual(counted,expected[stage].asked,stage);
    assert.deepEqual(f.calls("id LIKE '%GERMANY%'"),expected[stage].germany,stage);
    // Every known bill is in the ledger exactly once, and an unanswered dispatched call is still held.
    const ledger=await f.ledger();
    assert.equal(ledger.settled,f.billed(),stage);assert.equal(ledger.reserved,0,stage);assert.equal(ledger.unknown>0,expected[stage].unknown,stage);
    // The accepted human command is still idempotent and was never reopened for editing.
    assert.equal((await service.submit(f.command)).state.status,'ACCEPTED',stage);
    await assert.rejects(service.submit({...f.command,requestId:'again'}),{code:'STORE_CONFLICT'},stage);
  }
});

test('validation completing after the call deadline cannot save an answer for recovery to reuse',async t=>{
  const f=await setup(t),original=f.rules.validate.bind(f.rules);
  let reached!:()=>void,release!:()=>void,delay=true;
  const started=new Promise<void>(done=>{reached=done;}),blocked=new Promise<void>(done=>{release=done;});
  f.rules.validate=async(board,power,action,signal)=>{
    await original(board,power,action,signal);
    if(power==='AUSTRIA'&&delay){reached();await blocked;}
  };
  const service=f.service(f.scripted(),{timeoutMs:500});
  await service.submit(f.command);await started;await service.wait(f.attempt.id);
  assert.deepEqual(f.calls(),['AUSTRIA:1 FINISHED TIMEOUT']);
  const paid=(await f.ledger()).settled;assert.ok(paid>0);
  delay=false;release();await new Promise(done=>setImmediate(done));
  assert.deepEqual(await f.store.call('providerDecisions',{operationId:f.operation()}),[]);
  // Preserve the late-validation fence assertion; recovery uses the normal deadline.
  const recovery=f.service(f.scripted());
  await recovery.recover(f.attempt.id);await recovery.wait(f.attempt.id);
  assert.equal((await f.current())!.board.season,'FALL');
  assert.deepEqual(f.sent.map(s=>s.power),['AUSTRIA',...OPPONENTS]);
  assert.ok((await f.ledger()).settled>paid);assert.equal((await f.ledger()).settled,f.billed());
});


test('HTTP preflight counts the complete fixed input, then sends its exact bytes only once',async()=>{
  const seen:Array<{url:string;init:RequestInit}>=[],body=buildLunaRequest({context:'public board 🎲'}).body;
  const fetchImpl=(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    seen.push({url:String(url),init:init!});
    return new Response(String(url)===LUNA_PRESET.countEndpoint ? JSON.stringify({object:'response.input_tokens',input_tokens:LUNA_PRESET.maxInputTokens}) : '{"id":"resp_1"}');
  }) as typeof fetch;
  const http=httpLunaTransport('test-key-not-real',fetchImpl),signal=new AbortController().signal;
  await assert.rejects(http({body,signal}),/requires a successful/);assert.equal(seen.length,0);
  const counted=await http.preflight!({body,signal});assert.equal(counted.inputTokens,LUNA_PRESET.maxInputTokens);
  const full=JSON.parse(body),input=JSON.parse(String(seen[0].init.body));
  assert.deepEqual(Object.keys(input).sort(),['input','instructions','model','reasoning','text','tool_choice','tools','truncation']);
  for(const key of Object.keys(input))assert.deepEqual(input[key],full[key],key);
  assert.equal(seen[0].url,LUNA_PRESET.countEndpoint);
  await assert.rejects(counted.send({body:body+' ',signal}),/does not authorize/);
  assert.deepEqual(await counted.send({body,signal}),{status:200,body:{id:'resp_1'}});
  assert.equal(seen[1].url,LUNA_PRESET.endpoint);assert.equal(seen[1].init.body,body);
  for(const {init} of seen){assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal((init.headers as Record<string,string>).Authorization,'Bearer test-key-not-real');}
  await assert.rejects(counted.send({body,signal}),/repeated dispatch/);assert.equal(seen.length,2);
  // A crafted fixed setting cannot reach either endpoint, even when its context is valid.
  for(const patch of [{model:'another-model'},{instructions:'override'},{tools:[{type:'web_search'}]},{max_output_tokens:100000},{service_tier:'priority'}, {text:{format:{type:'text'}}}])
    await assert.rejects(http.preflight!({body:JSON.stringify({...full,...patch}),signal}),/request contract/);
  assert.equal(seen.length,2);assert.throws(()=>httpLunaTransport(''),/key is required/);
});

test('invalid, oversized, unavailable and cancelled counts never create a model response',async()=>{
  const body=buildLunaRequest({context:'public board'}).body,signal=new AbortController().signal;
  const invalid=[null,{}, {object:'response.input_tokens',input_tokens:0},{object:'response.input_tokens',input_tokens:1.5},
    {object:'response.input_tokens',input_tokens:'1'},{object:'response.input_tokens',input_tokens:LUNA_PRESET.maxInputTokens+1},
    {object:'response',input_tokens:100}, {object:'response.input_tokens',input_tokens:100,error:'private error'}];
  for(const value of invalid){
    let n=0;
    const http=httpLunaTransport('test-key-not-real',(async()=>{n++;return new Response(JSON.stringify(value));}) as typeof fetch);
    await assert.rejects(http.preflight!({body,signal}),/preflight/);assert.equal(n,1);
  }
  for(const [raw,status] of [['not json',200],['x'.repeat(LUNA_PRESET.maxCountResponseBytes+1),200],['private provider error',401]] as const){
    const seen:string[]=[],http=httpLunaTransport('test-key-not-real',(async url=>{seen.push(String(url));return new Response(raw,{status});}) as typeof fetch);
    await assert.rejects(http.preflight!({body,signal}),error=>error instanceof Error&&/preflight/.test(error.message)&&!error.message.includes('private'));
    assert.deepEqual(seen,[LUNA_PRESET.countEndpoint]);
  }
  let reached!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>{reached=r;}),blocked=new Promise<void>(r=>{release=r;}),controller=new AbortController(),seen:string[]=[];
  const http=httpLunaTransport('test-key-not-real',(async url=>{seen.push(String(url));reached();await blocked;return new Response('{"object":"response.input_tokens","input_tokens":100}');}) as typeof fetch);
  const pending=http.preflight!({body,signal:controller.signal});await started;controller.abort();
  await assert.rejects(pending,/preflight unavailable/);release();await new Promise(done=>setImmediate(done));
  assert.deepEqual(seen,[LUNA_PRESET.countEndpoint]);
});

test('generation keeps its body size cap and unknown-usage failure behavior after a successful count',async()=>{
  const body=buildLunaRequest({context:'public board'}).body,signal=new AbortController().signal;
  for(const [raw,status,tooLarge] of [['not json',500,false],['x'.repeat(LUNA_PRESET.maxResponseBytes+1),200,true]] as const){
    const http=httpLunaTransport('test-key-not-real',(async url=>new Response(String(url)===LUNA_PRESET.countEndpoint ? '{"object":"response.input_tokens","input_tokens":100}' : raw,{status:String(url)===LUNA_PRESET.countEndpoint ? 200 : status})) as typeof fetch);
    const prepared=await http.preflight!({body,signal});
    if(tooLarge)await assert.rejects(prepared.send({body,signal}),/size limit/);
    else assert.deepEqual(await prepared.send({body,signal}),{status:500,body:null});
  }
});

test('counter refusal releases only the unsent reservation, leaves recovery possible, and retries under a new call',async t=>{
  const f=await setup(t),seen:string[]=[],mock=mockLunaTransport();let valid=false;
  const http=httpLunaTransport('test-key-not-real',(async(url,init)=>{
    seen.push(String(url));
    if(String(url)===LUNA_PRESET.countEndpoint)return new Response(JSON.stringify({object:'response.input_tokens',input_tokens:valid?100:LUNA_PRESET.maxInputTokens+1}));
    const result=await mock({body:String(init!.body),signal:init!.signal as AbortSignal});return new Response(JSON.stringify(result.body));
  }) as typeof fetch),service=f.service(http);
  await service.submit(f.command);await service.wait(f.attempt.id);
  assert.deepEqual(seen,[LUNA_PRESET.countEndpoint]);assert.deepEqual(await f.ledger(),{settled:0,reserved:0,unknown:0});
  assert.deepEqual(f.calls(),['AUSTRIA:1 FINISHED CANCELLED']);assert.equal((await f.current())!.execution,'RECOVERING');
  valid=true;await service.recover(f.attempt.id);await service.wait(f.attempt.id);
  assert.equal((await f.current())!.board.season,'FALL');assert.equal((await f.reports()).length,1);
  assert.equal(seen.filter(x=>String(x)===LUNA_PRESET.endpoint).length,6);
  assert.ok((await f.store.call('providerCallsForAttempt',{attemptId:f.attempt.id})).every(c=>c.maxCostNanousd===lunaReservationNanousd(LUNA_PRESET.maxInputTokens)));
});

test('no funds means no count; stopping during count prevents subsequent generation dispatch',async t=>{
  const empty=await setup(t,0);let outbound=0;
  const noFunds=empty.service(httpLunaTransport('test-key-not-real',(async()=>{outbound++;throw new Error();}) as typeof fetch));
  await noFunds.submit(empty.command);await noFunds.wait(empty.attempt.id);assert.equal(outbound,0);
  const f=await setup(t),seen:string[]=[],service=f.service(httpLunaTransport('test-key-not-real',(async url=>{
    seen.push(String(url));
    await f.store.call('setPaidStopped',{stopped:true,operatorId:'owner',now:f.now()});
    return new Response('{"object":"response.input_tokens","input_tokens":100}');
  }) as typeof fetch));
  await service.submit(f.command);await service.wait(f.attempt.id);
  assert.deepEqual(seen,[LUNA_PRESET.countEndpoint]);assert.equal((await f.current())!.execution,'RECOVERING');
  assert.equal((await f.ledger()).settled,0);assert.equal((await f.ledger()).unknown,0);
  assert.deepEqual(f.calls(),['AUSTRIA:1 FINISHED CANCELLED']);assert.equal((await f.ledger()).reserved,0);
});


test('the count deadline bounds a counter that ignores cancellation',async()=>{
  const seen:string[]=[],body=buildLunaRequest({context:'public board'}).body;
  const http=httpLunaTransport('test-key-not-real',(async url=>{
    seen.push(String(url));await new Promise(done=>setTimeout(done,LUNA_PRESET.countTimeoutMs+200));
    return new Response('{"object":"response.input_tokens","input_tokens":100}');
  }) as typeof fetch);
  const began=performance.now();
  await assert.rejects(http.preflight!({body,signal:new AbortController().signal}),/preflight unavailable/);
  assert.ok(performance.now()-began < LUNA_PRESET.countTimeoutMs+1500);
  assert.deepEqual(seen,[LUNA_PRESET.countEndpoint]);
});


test('a fetch that aborts synchronously cannot leave an unhandled rejected count promise',async()=>{
  const controller=new AbortController(),body=buildLunaRequest({context:'public board'}).body;
  const http=httpLunaTransport('test-key-not-real',(()=>{controller.abort();return Promise.reject(new Error('private transport failure'));}) as typeof fetch);
  await assert.rejects(http.preflight!({body,signal:controller.signal}),/preflight unavailable/);
  await new Promise(done=>setImmediate(done));
});


const until=async(check:()=>Promise<boolean>)=>{const end=performance.now()+3_000;while(!await check()){if(performance.now()>end)throw new Error('Expected durable state was not reached');await new Promise(done=>setImmediate(done));}};

test('the production preset overlaps six independently reserved calls and commits one complete phase',{timeout:8_000},async t=>{
  const f=await setup(t);let active=0,peak=0,entered=0,ready!:()=>void,release!:()=>void;
  const started=new Promise<void>(done=>{ready=done;}),gate=new Promise<void>(done=>{release=done;}),mock=mockLunaTransport();
  const transport=f.scripted(async(_power,request)=>{
    active++;peak=Math.max(peak,active);if(++entered===6)ready();
    await Promise.race([gate,new Promise<never>((_,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))]);
    active--;return mock(request);
  });
  const service=f.service(transport,{},false);await service.submit(f.command);await started;
  const held=await f.ledger();assert.equal(peak,LUNA_PRESET.maxConcurrentDecisions);assert.equal(active,6);
  assert.equal(held.reserved,6*lunaReservationNanousd(LUNA_PRESET.maxInputTokens));assert.equal(held.settled,0);
  release();await service.wait(f.attempt.id);assert.equal((await f.current())!.board.season,'FALL');
  assert.equal((await f.reports()).length,1);assert.equal((await f.store.call('providerDecisions',{operationId:f.operation()})).length,6);
  assert.deepEqual(await f.ledger(),{settled:f.billed(),reserved:0,unknown:0});
});

test('a failed power starts no queued powers, and an in-flight sibling finishes, settles and is reused by the recovery',async t=>{
  const f=await setup(t),mock=mockLunaTransport();let england!:()=>void,release!:()=>void;
  const both=new Promise<void>(done=>{england=done;}),failedFirst=new Promise<void>(done=>{release=done;});
  const transport=f.scripted(async(power,request)=>{
    // Austria fails every call it is allowed; England is still in flight when the phase is given up on.
    if(power==='AUSTRIA'){await both;setTimeout(release,150);return completed('not json','resp_parallel_bad');}
    if(power==='ENGLAND'){england();await failedFirst;return mock(request);}
    throw new Error('Queued power must not start');
  });
  const service=f.service(transport,{maxConcurrentDecisions:2});await service.submit(f.command);await service.wait(f.attempt.id);
  assert.deepEqual([...new Set(f.sent.map(x=>x.power))].sort(),['AUSTRIA','ENGLAND']);assert.equal((await f.current())!.execution,'RECOVERING');
  const calls=await f.store.call('providerCallsForAttempt',{attemptId:f.attempt.id}),old=calls.find(c=>c.power==='ENGLAND')!;
  // The sibling was not cancelled: its bill is known, nothing is left as unknown liability and its answer is kept.
  assert.equal(old.outcome,'VALID');assert.ok(old.usage);
  assert.deepEqual(await f.ledger(),{settled:f.billed(),reserved:0,unknown:0});
  assert.equal((await f.store.call('providerDecisions',{operationId:f.operation()})).some(d=>d.callId===old.id),true);
  const before=f.sent.length,recovered=f.service(f.scripted(),{},false);await recovered.recover(f.attempt.id);await recovered.wait(f.attempt.id);
  assert.equal((await f.reports()).length,1);
  // England's paid answer is reused; the recovery buys nothing for it a second time.
  assert.equal(f.sent.slice(before).some(x=>x.power==='ENGLAND'),false);
  assert.deepEqual(await f.ledger(),{settled:f.billed(),reserved:0,unknown:0});
});

test('a budget narrower than the worker pool makes concurrent powers wait for a sibling to settle instead of pausing paid play',async t=>{
  for(const limited of ['pool','attempt'] as const){
    // Four worst cases cover a whole phase run one at a time; six workers must not turn that into an outage.
    const reserve=lunaReservationNanousd(LUNA_PRESET.maxInputTokens),f=await setup(t,limited==='pool'?4*reserve:1_000_000_000);
    if(limited==='attempt')await f.store.call('setFundingPolicy',{attemptCapNanousd:4*reserve,ceilingLimitNanousd:null,now:f.now()});
    let open=0,widest=0;
    const mock=mockLunaTransport({pick:'seeded',seed:7});
    const transport:LunaTransport=async request=>{open++;widest=Math.max(widest,open);try{await new Promise(r=>setTimeout(r,20));return await mock(request);}finally{open--;}};
    const service=f.service(transport,{maxConcurrentDecisions:6},false);await service.submit(f.command);await service.wait(f.attempt.id);
    assert.equal((await f.reports()).length,1,limited);assert.notEqual((await f.current())!.execution,'RECOVERING',limited);
    assert.ok(widest>1&&widest<=4,`${limited}: ${widest} calls overlapped`);
    assert.equal((await f.store.call('paidState',{})).stopped,false,limited);
    const calls=await f.store.call('providerCallsForAttempt',{attemptId:f.attempt.id});
    assert.ok(calls.length>4&&calls.every(c=>c.outcome==='VALID'),limited);
    assert.deepEqual(await f.ledger(),{settled:f.billed(),reserved:0,unknown:0},limited);
  }
});
test('real exhaustion with nothing in flight still refuses and pauses paid play',async t=>{
  const reserve=lunaReservationNanousd(LUNA_PRESET.maxInputTokens),f=await setup(t,reserve-1);
  const service=f.service(f.scripted(),{maxConcurrentDecisions:6},false);await service.submit(f.command);await service.wait(f.attempt.id);
  assert.equal(f.sent.length,0);assert.equal((await f.store.call('paidState',{})).stopped,true);
  assert.deepEqual(await f.ledger(),{settled:0,reserved:0,unknown:0});
});
test('concurrent pool and per-attempt admission cannot overbook and failed preflight workers release all unsent holds',async t=>{
  for(const limited of ['pool','attempt'] as const){
    const reserve=lunaReservationNanousd(LUNA_PRESET.maxInputTokens),f=await setup(t,limited==='pool'?2*reserve:1_000_000_000);
    if(limited==='attempt')await f.store.call('setFundingPolicy',{attemptCapNanousd:2*reserve,ceilingLimitNanousd:null,now:f.now()});
    let counted=0,sent=0;
    const transport:LunaTransport=async()=>{sent++;throw new Error('No generation authorized');};
    transport.preflight=async({signal})=>{counted++;return new Promise((_,reject)=>{if(signal.aborted)reject(new Error());else signal.addEventListener('abort',()=>reject(new Error()),{once:true});});};
    const service=f.service(transport,{},false);await service.submit(f.command);await service.wait(f.attempt.id);
    assert.equal(counted,2,limited);assert.equal(sent,0,limited);assert.equal((await f.current())!.execution,'RECOVERING',limited);
    const calls=await f.store.call('providerCallsForAttempt',{attemptId:f.attempt.id});assert.equal(calls.length,2,limited);
    assert.ok(calls.every(c=>c.dispatchedAt===null&&c.outcome==='CANCELLED'),limited);
    assert.deepEqual(await f.ledger(),{settled:0,reserved:0,unknown:0},limited);
    assert.equal((await f.reports()).length,0,limited);assert.ok((await f.store.call('fundingTotals',{})).availableNanousd>=0,limited);
  }
});

test('stop, ban and abandon during six concurrent counts prevent every generation and release only unsent holds',{timeout:12_000},async t=>{
  for(const action of ['stop','ban','abandon'] as const){
    const f=await setup(t);let entered=0,ready!:()=>void,release!:()=>void,sent=0;
    const started=new Promise<void>(done=>{ready=done;}),gate=new Promise<void>(done=>{release=done;});
    const transport:LunaTransport=async()=>{sent++;throw new Error('Should not send');};
    transport.preflight=async({signal})=>{
      if(++entered===6)ready();
      await Promise.race([gate,new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error()),{once:true}))]);
      return {inputTokens:100,send:transport};
    };
    const service=f.service(transport,{},false);await service.submit(f.command);await started;
    if(action==='stop')await f.store.call('setPaidStopped',{stopped:true,operatorId:'owner',now:f.now()});
    else if(action==='ban')await service.banPlayer(f.player.id);
    else await service.terminate(f.attempt.id,f.player.id,'ABANDONED');
    release();await service.wait(f.attempt.id);
    // The coordinator may finish its cancellation before the provider drain; wait for that durable drain too.
    await until(async()=>(await f.ledger()).reserved===0);
    assert.equal(sent,0,action);assert.equal((await f.reports()).length,0,action);
    assert.deepEqual(await f.ledger(),{settled:0,reserved:0,unknown:0},action);
    assert.ok((await f.store.call('providerCallsForAttempt',{attemptId:f.attempt.id})).every(c=>c.dispatchedAt===null&&c.outcome==='CANCELLED'),action);
  }
});

test('a sponsored attempt pinned to an older preset cannot silently adopt concurrent settings',async t=>{
  const f=await setup(t),old=await f.store.call('createAttempt',{id:'old-preset',playerId:f.player.id,challengeId:'tunis-expedition',challengeVersion:1,reconnectTokenHash:hashToken('old'),now:f.now(),
    sponsored:{preset:{id:'luna-challenge-v1',pricingVersion:LUNA_PRESET.pricingVersion},minimumAvailableNanousd:lunaReservationNanousd(LUNA_PRESET.maxInputTokens)}});
  const service=f.service(f.scripted(),{},false);await service.submit({...f.command,attemptId:old.id,phaseId:old.phaseId});await service.wait(old.id);
  assert.equal(f.sent.length,0);assert.equal((await f.store.call('attempt',{id:old.id}))!.execution,'RECOVERING');
  assert.deepEqual(await f.ledger(),{settled:0,reserved:0,unknown:0});
  for(const bad of [0,7,1.5])assert.throws(()=>new LunaDecisionProvider(f.store,f.rules,f.scripted(),{maxConcurrentDecisions:bad}),/concurrency/);
});

test('parallel SIGKILL retains all holds, saved answers and exactly one recovered phase',async t=>{
  for(const stage of ['RESERVED','DISPATCHED','DECIDED']){
    const f=await setup(t),child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/crashParallelLuna.js',import.meta.url)),f.path,stage,JSON.stringify(f.command)],{stdio:'ignore',env:{PATH:process.env.PATH}});
    const [code,signal]=await once(child,'exit');assert.equal(code,null,stage);assert.equal(signal,'SIGKILL',stage);
    const before=await f.store.call('providerCallsForAttempt',{attemptId:f.attempt.id});assert.equal(before.length,6,stage);
    const saved=await f.store.call('providerDecisions',{operationId:f.operation()});assert.equal(saved.length,stage==='DECIDED'?1:0,stage);
    await f.reopen();const service=f.service(f.scripted(),{},false);await service.recover(f.attempt.id);await service.wait(f.attempt.id);
    assert.equal((await f.current())!.board.season,'FALL',stage);assert.equal((await f.reports()).length,1,stage);
    assert.equal(f.sent.length,6-saved.length,stage);
    for(const decision of saved)assert.equal(f.sent.some(x=>x.power===decision.power),false,stage);
    const ledger=await f.ledger();assert.equal(ledger.settled,f.billed(),stage);assert.equal(ledger.reserved,0,stage);
    assert.equal(ledger.unknown,(stage==='RESERVED'?0:6-saved.length)*lunaReservationNanousd(LUNA_PRESET.maxInputTokens),stage);
    const sent=f.sent.length;await service.recover(f.attempt.id);await service.wait(f.attempt.id);assert.equal(f.sent.length,sent,stage);
    assert.equal((await service.submit(f.command)).state.status,'ACCEPTED',stage);
  }
});


test('a stale worker drain cannot release a newer recovery revision reservation',async t=>{
  const f=await setup(t),accepted=await f.store.call('beginPhase',{id:f.attempt.id,playerId:f.player.id,expectedRevision:0,phaseId:f.attempt.phaseId,requestId:'race',operationId:'parallel-race',action:f.command.action,now:f.now()});
  let oldReady!:()=>void,newReady!:()=>void,releaseOld!:()=>void,releaseNew!:()=>void;
  const oldStarted=new Promise<void>(done=>{oldReady=done;}),newStarted=new Promise<void>(done=>{newReady=done;});
  const oldGate=new Promise<void>(done=>{releaseOld=done;}),newGate=new Promise<void>(done=>{releaseNew=done;});
  const first:LunaTransport=async()=>{throw new Error('Old generation must never be sent');};
  first.preflight=async()=>{oldReady();await oldGate;return {inputTokens:100,send:first};};
  const second=f.scripted();second.preflight=async input=>{if(powerOf(input.body)==='AUSTRIA'){newReady();await newGate;}return {inputTokens:100,send:second};};
  const oldSignal=new AbortController(),newSignal=new AbortController();
  const oldProvider=new LunaDecisionProvider(f.store,f.rules,first,{now:f.now,maxConcurrentDecisions:1});
  const newProvider=new LunaDecisionProvider(f.store,f.rules,second,{now:f.now,maxConcurrentDecisions:1});
  const oldRun=oldProvider.decide({job:accepted.job,signal:oldSignal.signal});void oldRun.catch(()=>{});
  let newRun:ReturnType<LunaDecisionProvider['recover']>|undefined;
  try {
    await oldStarted;const job=await f.store.call('recoverPhase',{fence:accepted.job,countRecovery:true,now:f.now()});
    assert.notEqual(job.revision,accepted.job.revision);
    newRun=newProvider.recover({job,signal:newSignal.signal});void newRun.catch(()=>{});await newStarted;
    const current=(await f.store.call('providerCallsForOperation',{operationId:job.operationId})).find(c=>c.state==='PREPARED'&&c.fence.revision===job.revision)!;
    assert.ok(current);oldSignal.abort();releaseOld();await assert.rejects(oldRun);
    assert.equal((await f.store.call('providerCall',{id:current.id}))!.state,'PREPARED','old cleanup cannot touch the new fence');
    releaseNew();assert.equal(Object.keys(await newRun).length,6);assert.equal((await f.ledger()).reserved,0);
  } finally {
    releaseOld();releaseNew();oldSignal.abort();newSignal.abort();await Promise.allSettled([oldRun,...(newRun?[newRun]:[])]);
  }
});
