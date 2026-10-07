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
import { LUNA_PRESET } from '../providers/LunaPreset.js';

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
  const service=(transport:LunaTransport,options:ConstructorParameters<typeof LunaDecisionProvider>[3]={})=>{
    const s=new AttemptService(store,new LunaDecisionProvider(store,rules,transport,{now:()=>now,...options}),rules,{now:()=>now});services.push(s);return s;
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
  const f=await setup(t,1_650_000),service=f.service(f.scripted());
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
  const service=f.service(f.scripted((power,request)=>power==='ENGLAND'&&hang?new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})):null),{timeoutMs:150});
  await service.submit(f.command);await service.wait(f.attempt.id);
  assert.equal((await f.current())!.execution,'RECOVERING');
  assert.deepEqual(f.calls("id LIKE '%ENGLAND%'"),['ENGLAND:1 FINISHED TIMEOUT']);
  const held=await f.ledger();assert.ok(held.unknown>0);assert.equal(held.reserved,0);
  hang=false;await service.recover(f.attempt.id);await service.wait(f.attempt.id);
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
    const service=f.service(f.scripted());
    await service.recover();await service.wait(f.attempt.id);
    const state=(await f.current())!;
    assert.deepEqual([state.board.season,state.execution,state.lifecycle],['FALL','ACCEPTING','ACTIVE'],stage);
    assert.equal((await f.reports()).length,1,stage);
    assert.deepEqual(f.sent.map(s=>s.power),expected[stage].asked,stage);
    assert.deepEqual(f.calls("id LIKE '%GERMANY%'"),expected[stage].germany,stage);
    // Every known bill is in the ledger exactly once, and an unanswered dispatched call is still held.
    const ledger=await f.ledger();
    assert.equal(ledger.settled,f.billed(),stage);assert.equal(ledger.reserved,0,stage);assert.equal(ledger.unknown>0,expected[stage].unknown,stage);
    // The accepted human command is still idempotent and was never reopened for editing.
    assert.equal((await service.submit(f.command)).state.status,'ACCEPTED',stage);
    await assert.rejects(service.submit({...f.command,requestId:'again'}),{code:'STORE_CONFLICT'},stage);
  }
});

test('the HTTP transport sends the exact reserved bytes once, caps the response and surfaces failures without leaking them',async()=>{
  const seen:Array<{url:string;init:RequestInit}>=[];
  const respond=(body:string,status=200)=>(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{seen.push({url:String(url),init:init!});return new Response(body,{status});}) as typeof fetch;
  const send=(fetchImpl:typeof fetch)=>httpLunaTransport('test-key-not-real',fetchImpl)({body:'{"exact":"bytes"}',signal:new AbortController().signal});
  assert.deepEqual(await send(respond('{"id":"resp_1"}')),{status:200,body:{id:'resp_1'}});
  assert.equal(seen[0].url,LUNA_PRESET.endpoint);assert.equal(seen[0].init.body,'{"exact":"bytes"}');assert.equal(seen[0].init.method,'POST');
  assert.equal((seen[0].init.headers as Record<string,string>).Authorization,'Bearer test-key-not-real');assert.equal(seen[0].init.redirect,'error');
  assert.deepEqual(await send(respond('not json',500)),{status:500,body:null});
  await assert.rejects(send(respond('x'.repeat(LUNA_PRESET.maxResponseBytes+1))),/size limit/);
  await assert.rejects(send((async()=>{throw new Error('socket hang up with secret detail');}) as typeof fetch));
  assert.equal(seen.length,3);
  assert.throws(()=>httpLunaTransport(''),/key is required/);
});

test('validation completing after the call deadline cannot save an answer for recovery to reuse',async t=>{
  const f=await setup(t),original=f.rules.validate.bind(f.rules);
  let reached!:()=>void,release!:()=>void,delay=true;
  const started=new Promise<void>(done=>{reached=done;}),blocked=new Promise<void>(done=>{release=done;});
  f.rules.validate=async(board,power,action,signal)=>{
    await original(board,power,action,signal);
    if(power==='AUSTRIA'&&delay){reached();await blocked;}
  };
  const service=f.service(f.scripted(),{timeoutMs:30});
  await service.submit(f.command);await started;await service.wait(f.attempt.id);
  assert.deepEqual(f.calls(),['AUSTRIA:1 FINISHED TIMEOUT']);
  const paid=(await f.ledger()).settled;assert.ok(paid>0);
  delay=false;release();await new Promise(done=>setImmediate(done));
  assert.deepEqual(await f.store.call('providerDecisions',{operationId:f.operation()}),[]);
  await service.recover(f.attempt.id);await service.wait(f.attempt.id);
  assert.equal((await f.current())!.board.season,'FALL');
  assert.deepEqual(f.sent.map(s=>s.power),['AUSTRIA',...OPPONENTS]);
  assert.ok((await f.ledger()).settled>paid);assert.equal((await f.ledger()).settled,f.billed());
});
