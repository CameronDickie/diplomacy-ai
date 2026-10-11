import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { Store } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { HAIKU_CONTRACT,LUNA_CONTRACT } from '../providers/OpponentContract.js';
import { mixedPlan,singlePlan } from '../providers/OpponentPlan.js';
import type { ChallengeAttemptView,ChallengeCatalog,ChallengeLegalCatalog,GameRecord,PlayerSession,PlaytestLog } from '@diplomacy/shared';

const SECRET='playtest-secret-'.repeat(3);
const local={DIPLOMACY_PROFILE:'local',DIPLOMACY_AUTH_SESSION_SECRET:SECRET};
const MIX='AUSTRIA=haiku,ENGLAND=haiku,GERMANY=haiku';

async function setup(t:test.TestContext,env:Record<string,string>,granted=1_000_000_000){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-playtest-')),path=join(dir,'game.sqlite'),store=await Store.open(path);
  const now=()=>Date.parse('2027-01-01T12:00:00Z'),config=readRuntimeConfig(env);
  if(granted)await store.call('grantFunding',{amountNanousd:granted,authorizationRef:'playtest-grant-0001',grantedBy:'test',now:now()});
  const auth=new AuthService(store,config,env,undefined,now),service=await ChallengeService.open(store,config,now,{env});
  const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api/auth',auth.router());app.use('/api',service.router(auth));
  app.use('/api',(_q,r)=>{r.status(404).json({code:'NOT_FOUND'});});
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const request=(route:string,cookie='',body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const signIn=async()=>{const r=await request('/auth/dev-login','',{});return {status:r.status,cookie:(r.headers.get('set-cookie')??'').split(';')[0]};};
  async function turn(cookie:string,id:string){
    const view=await (await request(`/attempts/${id}`,cookie)).json() as ChallengeAttemptView;
    const legal=await (await request(`/attempts/${id}/legal`,cookie)).json() as ChallengeLegalCatalog;
    const response=await request(`/attempts/${id}/orders`,cookie,{revision:view.revision,phaseId:view.phaseId,requestId:`orders-${view.revision}`,action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}});
    assert.equal(response.status,200);await service.attempts.wait(id);
    return await (await request(`/attempts/${id}`,cookie)).json() as ChallengeAttemptView;
  }
  const sql=<T>(work:(db:DatabaseSync)=>T)=>{const db=new DatabaseSync(path,{readOnly:true});try{return work(db);}finally{db.close();}};
  return {request,signIn,turn,sql,config,store,start:(requestId:string)=>({requestId,challengeId:'tunis-expedition',challengeVersion:1,mode:'SPONSORED'})};
}

test('every development switch is refused outside the local, non-production profile bound to this machine',()=>{
  const keys={OPENAI_API_KEY:'synthetic-openai-key',ANTHROPIC_API_KEY:'synthetic-anthropic-key'};
  const switches:Array<[string,Record<string,string>]>=[['live transport',{DIPLOMACY_LUNA_TRANSPORT:'live',...keys}],['mock transport',{DIPLOMACY_LUNA_TRANSPORT:'mock'}],
    ['per-power models',{DIPLOMACY_LUNA_TRANSPORT:'mock',DIPLOMACY_PLAYTEST_OPPONENTS:MIX}],['development sign-in',{DIPLOMACY_DEV_LOGIN:'true'}]];
  const origins={DIPLOMACY_AUTH_CALLBACK_ORIGIN:'https://game.example.test',DIPLOMACY_AUTH_RETURN_ORIGIN:'https://game.example.test'};
  for(const [name,extra] of switches){
    assert.doesNotThrow(()=>readRuntimeConfig({...local,...extra}),name);
    for(const [where,base] of [['showcase',{DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:SECRET}],['private',{DIPLOMACY_PROFILE:'private',DIPLOMACY_AUTH_SESSION_SECRET:SECRET}],
      ['production showcase',{NODE_ENV:'production',DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:SECRET,...origins}]] as const)
      assert.throws(()=>readRuntimeConfig({...base,...extra}),/local development profile/,`${name} in ${where}`);
    // A local profile cannot be a production build at all, so there is no production path to these switches.
    assert.throws(()=>readRuntimeConfig({...local,NODE_ENV:'production',...origins,...extra}),/local cannot run in production/,name);
  }
  // Anything that spends or signs in without a provider must also be reachable from this machine only.
  for(const [name,extra] of [switches[0],switches[2],switches[3]])for(const host of ['0.0.0.0','192.168.1.20'])
    assert.throws(()=>readRuntimeConfig({...local,...extra,HOST:host}),/loopback/,`${name} on ${host}`);
  // Live needs the key of every model in use, and only those.
  assert.throws(()=>readRuntimeConfig({...local,DIPLOMACY_LUNA_TRANSPORT:'live'}),/OPENAI_API_KEY/);
  assert.throws(()=>readRuntimeConfig({...local,DIPLOMACY_LUNA_TRANSPORT:'live',DIPLOMACY_SPONSORED_PRESET:'haiku'}),/ANTHROPIC_API_KEY/);
  assert.doesNotThrow(()=>readRuntimeConfig({...local,DIPLOMACY_LUNA_TRANSPORT:'live',DIPLOMACY_SPONSORED_PRESET:'haiku',ANTHROPIC_API_KEY:keys.ANTHROPIC_API_KEY}));
  assert.throws(()=>readRuntimeConfig({...local,DIPLOMACY_LUNA_TRANSPORT:'live',DIPLOMACY_PLAYTEST_OPPONENTS:MIX,OPENAI_API_KEY:keys.OPENAI_API_KEY}),/ANTHROPIC_API_KEY/);
  for(const bad of ['AUSTRIA','AUSTRIA=sonnet','NARNIA=luna','AUSTRIA=luna,AUSTRIA=haiku','AUSTRIA=luna=haiku'])
    assert.throws(()=>readRuntimeConfig({...local,DIPLOMACY_LUNA_TRANSPORT:'mock',DIPLOMACY_PLAYTEST_OPPONENTS:bad}),/DIPLOMACY_PLAYTEST_OPPONENTS/,bad);
  assert.throws(()=>readRuntimeConfig({...local,DIPLOMACY_PLAYTEST_OPPONENTS:MIX}),/requires DIPLOMACY_LUNA_TRANSPORT/);
  assert.throws(()=>readRuntimeConfig({DIPLOMACY_PROFILE:'local',DIPLOMACY_DEV_LOGIN:'true'}),/DIPLOMACY_AUTH_SESSION_SECRET/);
  // Nothing is on by default, and the paid-startup refusal is unchanged.
  const plain=readRuntimeConfig({DIPLOMACY_PROFILE:'local'});
  assert.deepEqual([plain.lunaTransport,plain.devLogin,plain.playtestOpponents],['none',false,{}]);
});

test('a hand-built configuration cannot reach a provider or mint a session outside development',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-playtest-')),store=await Store.open(join(dir,'game.sqlite'));
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
  const showcase=readRuntimeConfig({DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:SECRET});
  const env={OPENAI_API_KEY:'synthetic-openai-key',ANTHROPIC_API_KEY:'synthetic-anthropic-key'};
  for(const forged of [{...showcase,lunaTransport:'live' as const},{...showcase,lunaTransport:'mock' as const},{...showcase,playtestOpponents:{AUSTRIA:'haiku' as const}},
    {...readRuntimeConfig({...local,DIPLOMACY_LUNA_TRANSPORT:'live',...env}),production:true}])
    await assert.rejects(ChallengeService.open(store,forged,Date.now,{env}),/not available in this profile/);
  // The sign-in route is not registered, so it answers like any unknown endpoint.
  for(const forged of [{...showcase,devLogin:true},{...readRuntimeConfig({...local,DIPLOMACY_DEV_LOGIN:'true'}),production:true},showcase,readRuntimeConfig(local)]){
    const auth=new AuthService(store,forged,{DIPLOMACY_AUTH_SESSION_SECRET:SECRET});
    const app=express();app.use(express.json());app.use('/api/auth',auth.router());
    const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address==='object');
    try{
      const response=await fetch(`http://127.0.0.1:${address.port}/api/auth/dev-login`,{method:'POST'});
      assert.equal(response.status,404);assert.equal(response.headers.get('set-cookie'),null);
      assert.equal((await (await fetch(`http://127.0.0.1:${address.port}/api/auth/session`)).json() as PlayerSession).devSignIn,undefined);
    }finally{await new Promise<void>(done=>server.close(()=>done()));}
  }
});

test('the development sign-in gives an ordinary player session that can never be an operator',async t=>{
  const f=await setup(t,{...local,DIPLOMACY_DEV_LOGIN:'true',DIPLOMACY_ADMIN_GITHUB_USER_IDS:'4242'});
  const before=await (await f.request('/auth/session')).json() as PlayerSession;
  assert.deepEqual([before.authenticated,before.enabled,before.devSignIn,before.providers],[false,true,true,[]]);
  const {status,cookie}=await f.signIn();
  assert.equal(status,204);assert.match(cookie,/^diplomacy_session=/);
  const session=await (await f.request('/auth/session',cookie)).json() as PlayerSession;
  assert.deepEqual([session.authenticated,session.operator,session.user?.displayName,session.capabilities.providerSettings],[true,false,'Local developer',false]);
  // Signing in again is the same account, with the earlier session rotated out.
  const again=await f.signIn();
  assert.equal(((await (await f.request('/auth/session',again.cookie)).json()) as PlayerSession).user?.id,session.user?.id);
  assert.equal(f.sql(db=>Number(db.prepare("SELECT count(*) n FROM players WHERE subject='local-development'").get()!.n)),1);
});

test('one mock game can mix models per power; each call is recorded under its own model and the log shows who chose what',async t=>{
  const outbound:string[]=[],realFetch=globalThis.fetch;
  globalThis.fetch=((input:Parameters<typeof fetch>[0],init?:RequestInit)=>{const url=String(input instanceof Request?input.url:input);if(url.startsWith('http://127.0.0.1'))return realFetch(input,init);outbound.push(url);throw new Error('no network in tests');}) as typeof fetch;
  t.after(()=>{globalThis.fetch=realFetch;});
  const f=await setup(t,{...local,DIPLOMACY_DEV_LOGIN:'true',DIPLOMACY_LUNA_TRANSPORT:'mock',DIPLOMACY_PLAYTEST_OPPONENTS:MIX});
  const catalog=await (await f.request('/challenges')).json() as ChallengeCatalog;
  assert.deepEqual([catalog.sponsoredPlay,catalog.sponsoredMock,catalog.sponsoredLive],['OPEN',true,undefined]);
  const {cookie}=await f.signIn();
  const started=await (await f.request('/attempts',cookie,f.start('mix-1'))).json() as ChallengeAttemptView;
  assert.match(started.challenge.opponentLabel,/^Mock Mixed opponents \(.*AUSTRIA claude-haiku-5-5.*\) · development stand-in, no provider calls$/);
  assert.match(started.challenge.opponentLabel,/RUSSIA gpt-6-luna/);
  const after=await f.turn(cookie,started.id);
  assert.equal(after.execution,'ACCEPTING');assert.ok(after.revision>started.revision);
  // The ledger records each power's call under the model assigned to it, at that model's own reservation.
  const calls=f.sql(db=>db.prepare("SELECT json_extract(intent_json,'$.power') power,json_extract(intent_json,'$.provider') provider,json_extract(intent_json,'$.model') model,json_extract(intent_json,'$.maxCostNanousd') held,outcome FROM provider_calls ORDER BY power").all().map(r=>({...r})));
  const expected=(power:string)=>['AUSTRIA','ENGLAND','GERMANY'].includes(power)?HAIKU_CONTRACT:LUNA_CONTRACT;
  assert.ok(calls.length>=4);
  for(const call of calls){
    const contract=expected(String(call.power));
    assert.deepEqual([call.provider,call.model,call.held,call.outcome],[contract.preset.provider,contract.preset.model,contract.reservationNanousd(contract.preset.maxInputTokens),'VALID'],String(call.power));
  }
  assert.deepEqual([...new Set(calls.map(c=>c.model))].sort(),['claude-haiku-5-5','gpt-6-luna']);
  // The attempt is pinned to this exact assignment, not to either model's own preset.
  const pinned=f.sql(db=>({...db.prepare('SELECT preset_id id,pricing_version pricing FROM attempts').get()!}));
  const plan=mixedPlan(f.config.playtestOpponents,LUNA_CONTRACT);
  assert.deepEqual(pinned,{id:plan.id,pricing:plan.pricingVersion});assert.match(String(pinned.id),/^playtest-mix-[a-f0-9]{16}$/);
  const log=await (await f.request(`/attempts/${started.id}/playtest`,cookie)).json() as PlaytestLog;
  // One submission can resolve more than one phase when the player has nothing to decide in the next.
  assert.ok(log.phases.length>=1);assert.equal(log.phases[0].kind,'ORDERS');
  const logged=log.phases.flatMap(phase=>phase.calls);assert.equal(logged.length,calls.length);
  for(const call of logged){
    assert.equal(call.model,expected(call.power).preset.model,call.power);assert.equal(call.outcome,'VALID');
    assert.ok(call.latencyMs!==null&&call.costNanousd!==null&&call.costNanousd>0&&call.heldNanousd===0);
    assert.ok(call.decision!==null&&typeof call.decision==='object');
  }
  const totals=Object.values(log.models);
  assert.equal(totals.reduce((n,m)=>n+m.calls,0),calls.length);assert.ok(totals.every(m=>m.valid===m.calls&&m.costNanousd>0));
  assert.equal(totals.reduce((n,m)=>n+m.costNanousd,0),(await f.store.call('fundingTotals',{})).settledNanousd);
  // Nothing private is in the log, and it belongs to the attempt's owner only.
  assert.equal(/You are |legal choices|Board text/.test(JSON.stringify(log)),false);
  assert.equal((await f.request(`/attempts/${started.id}/playtest`)).status,401);
  // The whole recorded game in one document: every phase's report with the calls that decided it.
  const record=await (await f.request(`/attempts/${started.id}/export`,cookie)).json() as GameRecord;
  assert.equal(record.attempt.id,started.id);assert.equal(record.attempt.humanPower,started.challenge.humanPower);
  assert.deepEqual(record.attempt.preset,{id:plan.id,pricingVersion:plan.pricingVersion});
  assert.equal(record.opponents.AUSTRIA,'claude-haiku-5-5');assert.equal(record.opponents.RUSSIA,'gpt-6-luna');
  assert.equal(record.phases.length,log.phases.length);
  assert.ok(record.phases.every(p=>p.report!==null&&p.calls.length>0&&p.phaseId.endsWith(`:${p.report!.year}:${p.report!.season}:${p.report!.phase}`)));
  assert.equal(record.phases.flatMap(p=>p.calls).length,calls.length);
  assert.deepEqual([record.chat,record.failures],[[],[]]);assert.match(record.note,/not stored/);
  assert.equal(/You are |legal choices|Board text|synthetic|secret/i.test(JSON.stringify(record)),false);
  assert.equal((await f.request(`/attempts/${started.id}/export`)).status,401);
  assert.deepEqual(outbound,[]);
});

test('the playtest log route does not exist unless a development transport is on',async t=>{
  const f=await setup(t,{...local,DIPLOMACY_DEV_LOGIN:'true'});
  const {cookie}=await f.signIn();
  assert.equal((await (await f.request('/challenges')).json() as ChallengeCatalog).sponsoredPlay,'NOT_OFFERED');
  assert.equal((await f.request('/attempts/anything/playtest',cookie)).status,404);
  assert.equal((await f.request('/attempts/anything/export',cookie)).status,404);
  // On a local development server the developer account, which is never an operator, may still choose any challenge.
  const library=await (await f.request('/challenges/library',cookie)).json() as {featuredId:string;challenges:Array<{id:string;version:number}>};
  assert.ok(library.challenges.length>=6);
  const other=library.challenges.find(c=>c.id!==library.featuredId)!;
  const chosen=await f.request('/attempts',cookie,{requestId:'library-1',challengeId:other.id,challengeVersion:other.version});
  assert.equal(chosen.status,200);assert.equal((await chosen.json() as ChallengeAttemptView).challenge.id,other.id);
  assert.equal((await f.request('/attempts',cookie,f.start('none-1'))).status,409);
});

test('an assignment is an identity: the same models in a different arrangement are a different plan',()=>{
  const a=mixedPlan({AUSTRIA:'haiku'},LUNA_CONTRACT),b=mixedPlan({ENGLAND:'haiku'},LUNA_CONTRACT),c=mixedPlan({AUSTRIA:'luna'},HAIKU_CONTRACT);
  assert.equal(new Set([a.id,b.id,c.id,LUNA_CONTRACT.preset.id,HAIKU_CONTRACT.preset.id]).size,5);
  assert.equal(a.pricingVersion,b.pricingVersion);assert.equal(mixedPlan({AUSTRIA:'haiku'},LUNA_CONTRACT).id,a.id);
  assert.deepEqual([a.contractFor('AUSTRIA').key,a.contractFor('TURKEY').key,a.mixed],['haiku','luna',true]);
  // The dearest call any power could make must be coverable before a game starts.
  assert.equal(a.reservationNanousd,Math.max(LUNA_CONTRACT.reservationNanousd(32_768),HAIKU_CONTRACT.reservationNanousd(32_768)));
  // Naming every power's default, or nothing, is not a mix: it is pinned exactly as that model always was.
  for(const same of [mixedPlan({},LUNA_CONTRACT),mixedPlan({AUSTRIA:'luna',ITALY:'luna'},LUNA_CONTRACT)])
    assert.deepEqual([same.id,same.pricingVersion,same.mixed],[singlePlan(LUNA_CONTRACT).id,LUNA_CONTRACT.preset.pricingVersion,false]);
});

test('a live playtest asks each power\'s own provider, with only that provider\'s key, and a failed count buys nothing',async t=>{
  type Outbound={host:string;path:string;openai:boolean;anthropic:boolean};
  const outbound=[] as Outbound[],realFetch=globalThis.fetch;
  globalThis.fetch=((input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const url=new URL(String(input instanceof Request?input.url:input));
    if(url.hostname==='127.0.0.1')return realFetch(input,init);
    const headers=new Headers(init?.headers);
    outbound.push({host:url.hostname,path:url.pathname,openai:(headers.get('authorization')??'').includes('synthetic-openai-key'),anthropic:headers.get('x-api-key')==='synthetic-anthropic-key'});
    // Answer slowly, so every power has asked before the first failure stops the rest from starting.
    return new Promise<Response>(done=>setTimeout(()=>done(new Response('{"error":{"message":"unavailable"}}',{status:503,headers:{'content-type':'application/json'}})),200));
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=realFetch;});
  const f=await setup(t,{...local,DIPLOMACY_DEV_LOGIN:'true',DIPLOMACY_LUNA_TRANSPORT:'live',DIPLOMACY_PLAYTEST_OPPONENTS:MIX,OPENAI_API_KEY:'synthetic-openai-key',ANTHROPIC_API_KEY:'synthetic-anthropic-key'});
  const catalog=await (await f.request('/challenges')).json() as ChallengeCatalog;
  assert.deepEqual([catalog.sponsoredPlay,catalog.sponsoredMock,catalog.sponsoredLive],['OPEN',false,true]);
  assert.deepEqual(outbound,[],'starting the server calls no provider');
  const {cookie}=await f.signIn();
  const started=await (await f.request('/attempts',cookie,f.start('live-1'))).json() as ChallengeAttemptView;
  assert.match(started.challenge.opponentLabel,/^Live Mixed opponents .* development playtest, real provider calls from your local ledger$/);
  const after=await f.turn(cookie,started.id);
  // The providers were unreachable: the phase waits with the player's orders saved; holds are never substituted.
  assert.equal(after.execution,'RECOVERING');assert.deepEqual([after.board.year,after.board.season,after.board.phase],[started.board.year,started.board.season,started.board.phase]);
  // Only the two token-count endpoints were contacted, each with its own key and never the other's.
  assert.ok(outbound.length>=2);
  for(const call of outbound as Outbound[]){
    assert.ok(call.host==='api.openai.com'&&call.path==='/v1/responses/input_tokens'&&call.openai&&!call.anthropic
      ||call.host==='api.anthropic.com'&&call.path==='/v1/messages/count_tokens'&&call.anthropic&&!call.openai,JSON.stringify(call));
  }
  assert.deepEqual([...new Set((outbound as Outbound[]).map(c=>c.host))].sort(),['api.anthropic.com','api.openai.com']);
  const totals=await f.store.call('fundingTotals',{});
  assert.deepEqual([totals.settledNanousd,totals.reservedNanousd,totals.unknownLiabilityNanousd],[0,0,0]);
  // In development the waiting turn says what actually happened, instead of a bare "try again".
  assert.equal(after.notice,'SPONSORED_RETRY');
  assert.ok(after.noticeDetail&&after.noticeDetail.length>=1,JSON.stringify(after.noticeDetail));
  assert.match(after.noticeDetail![0],/^[A-Z]+ could not decide \(PREFLIGHT\)$/);
  const record=await (await f.request(`/attempts/${started.id}/export`,cookie)).json() as GameRecord;
  assert.deepEqual(record.failures.map(x=>x.phaseId),[started.phaseId]);assert.match(record.failures[0].reason,/could not decide/);
  assert.equal(f.sql(db=>Number(db.prepare('SELECT count(*) n FROM provider_calls WHERE dispatched_at IS NOT NULL').get()!.n)),0);
});

test('a phase that asks nothing of the player is entered for them, as an ordinary recorded phase; one that needs them waits',async t=>{
  const { idleAction } = await import('../attempts/PhaseRules.js');
  const { readFile } = await import('node:fs/promises');
  const load=async(name:string)=>JSON.parse(await readFile(new URL(`../../fixtures/development/${name}.v1.json`,import.meta.url),'utf8')).board;
  const opening=await load('tunis-expedition'),retreat=await load('retreat-position'),winter=await load('winter-build');
  // Derived from the committed board alone: a power with units to order, a dislodged unit or a build owed is never skipped.
  for(const power of ['TURKEY','FRANCE','RUSSIA'] as const)assert.equal(idleAction(opening,power),null,power);
  const dislodged=retreat.units.find((u:{mustRetreat?:boolean})=>u.mustRetreat).power;
  assert.equal(idleAction(retreat,dislodged),null);
  assert.deepEqual(idleAction(retreat,dislodged==='TURKEY'?'ENGLAND':'TURKEY'),{phase:'RETREATS',retreats:{}});
  assert.equal(winter.phase,'BUILDS');
  // End to end: play practice turns and confirm the player is only ever stopped on a phase that needs a decision.
  const f=await setup(t,{...local,DIPLOMACY_DEV_LOGIN:'true',DIPLOMACY_LUNA_TRANSPORT:'mock'});
  const {cookie}=await f.signIn();
  let view=await (await f.request('/attempts',cookie,f.start('idle-1'))).json() as ChallengeAttemptView;
  const human=view.challenge.humanPower;
  for(let turn=0;turn<6&&view.lifecycle==='ACTIVE';turn++){
    assert.equal(view.execution,'ACCEPTING');
    assert.equal(idleAction(view.board as never,human),null,`stopped on ${view.board.season} ${view.board.year} ${view.board.phase} with nothing to decide`);
    if(view.board.phase!=='ORDERS')break;
    view=await f.turn(cookie,view.id);
  }
  // Skipped phases are still in the record: every phase the board passed through has a report.
  const reports=(await (await f.request(`/attempts/${view.id}/reports`,cookie)).json() as {reports:Array<{phase:string;season:string;year:number}>}).reports;
  assert.ok(reports.length>=2);
  assert.equal(new Set(reports.map(r=>`${r.year}-${r.season}-${r.phase}`)).size,reports.length);
});
