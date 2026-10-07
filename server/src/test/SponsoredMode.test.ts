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
import { Store,newToken } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { OperatorService } from '../operator/OperatorService.js';
import { localDelivery } from '../operator/Notifier.js';
import { mockLunaTransport,type LunaTransport } from '../luna/Transport.js';
import type { ChallengeAttemptView,ChallengeCatalog,ChallengeLegalCatalog,OperatorOverview } from '@diplomacy/shared';

async function setup(t:test.TestContext,options:{transport?:LunaTransport|null;granted?:number;env?:Record<string,string>}={}){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-sponsored-'));let now=Date.parse('2027-01-01T12:00:00Z');
  const path=join(dir,'game.sqlite');let store=await Store.open(path);
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4),DIPLOMACY_ADMIN_GITHUB_USER_IDS:'4242',...options.env};
  const config=readRuntimeConfig(env),sent:string[]=[],mock=mockLunaTransport({pick:'seeded',seed:11});
  // Counts requests so tests can assert that practice play and refused starts buy nothing.
  const transport:LunaTransport|undefined=options.transport===null?undefined:options.transport??(async request=>{sent.push(/You are ([A-Z]+)\./.exec(request.body)![1]);return mock(request);});
  if(options.granted??1_000_000_000)await store.call('grantFunding',{amountNanousd:options.granted??1_000_000_000,authorizationRef:'test-grant-0001',grantedBy:'test',now});
  let auth!:AuthService,service!:ChallengeService,operator!:OperatorService,close!:()=>Promise<void>,port=0;
  async function boot(){
    auth=new AuthService(store,config,env,undefined,()=>now);service=await ChallengeService.open(store,config,()=>now,{lunaTransport:transport});
    operator=new OperatorService(store,config,service.attempts,()=>now,localDelivery);
    const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api/operator',operator.router(auth));app.use('/api',service.router(auth));
    const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address==='object');port=address.port;
    close=async()=>{await new Promise<void>(done=>server.close(()=>done()));await operator.close();await service.close();};
  }
  await boot();
  const request=(route:string,cookie='',body?:unknown)=>fetch(`http://127.0.0.1:${port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function user(subject:string){
    const player=await store.call('identity',{provider:'github',subject,displayName:'Test',now});
    const cookie=`${auth.cookieName}=${newToken()}`;
    await store.call('createSession',{tokenHash:auth.tokenHash(cookie)!,playerId:player.id,now,expiresAt:now+86_400_000});return {player,cookie};
  }
  const start=(requestId:string,extra:Record<string,unknown>={})=>({requestId,challengeId:'tunis-expedition',challengeVersion:1,...extra});
  async function turn(cookie:string,id:string){
    const view=await (await request(`/attempts/${id}`,cookie)).json() as ChallengeAttemptView;
    const legal=await (await request(`/attempts/${id}/legal`,cookie)).json() as ChallengeLegalCatalog;
    const response=await request(`/attempts/${id}/orders`,cookie,{revision:view.revision,phaseId:view.phaseId,requestId:`orders-${view.revision}`,action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}});
    assert.equal(response.status,200);await service.attempts.wait(id);
    return await (await request(`/attempts/${id}`,cookie)).json() as ChallengeAttemptView;
  }
  const count=(table:string,where='1=1')=>{const db=new DatabaseSync(path,{readOnly:true});try{return Number(db.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get()!.n);}finally{db.close();}};
  t.after(async()=>{await close();await store.close();await rm(dir,{recursive:true,force:true});});
  return {request,user,start,turn,sent,count,config,get store(){return store;},get service(){return service;},now:()=>now,advance:(ms:number)=>{now+=ms;},
    catalog:async()=>await (await request('/challenges')).json() as ChallengeCatalog,
    async restart(){await close();await store.close();store=await Store.open(path);await boot();}};
}

test('a sponsored attempt is a distinct, pinned mode: its opponents are decided by the provider and practice attempts never are',async t=>{
  const f=await setup(t),sponsor=await f.user('sponsor'),practice=await f.user('practice'),owner=await f.user('4242');
  assert.deepEqual([(await f.catalog()).sponsoredPlay,(await f.catalog()).sponsoredMock],['OPEN',false]);
  const paid=await (await f.request('/attempts',sponsor.cookie,f.start('s-1',{mode:'SPONSORED'}))).json() as ChallengeAttemptView;
  const free=await (await f.request('/attempts',practice.cookie,f.start('p-1'))).json() as ChallengeAttemptView;
  assert.deepEqual([paid.mode,paid.challenge.mode,paid.challenge.opponentLabel,paid.notice],['SPONSORED','SPONSORED','GPT-6 Luna opponents · sponsored',null]);
  assert.deepEqual([free.mode,free.challenge.mode,free.challenge.opponentLabel],['PRACTICE','PRACTICE','Offline practice · hold-only opponents']);
  const stored=(await f.store.call('attempt',{id:paid.id}))!;
  assert.deepEqual(stored.preset,{id:'luna-challenge-v2',pricingVersion:'luna-standard-2026-10-07'});assert.equal((await f.store.call('attempt',{id:free.id}))!.preset,null);
  // Practice first: the engine resolves it with holding opponents and nothing is bought.
  assert.equal((await f.turn(practice.cookie,free.id)).board.season,'FALL');
  assert.deepEqual([f.sent.length,f.count('provider_calls')],[0,0]);
  const afterPaid=await f.turn(sponsor.cookie,paid.id);
  assert.deepEqual([afterPaid.board.season,afterPaid.execution,afterPaid.mode],['FALL','ACCEPTING','SPONSORED']);
  assert.deepEqual([...f.sent].sort(),['AUSTRIA','ENGLAND','FRANCE','GERMANY','ITALY','RUSSIA']);
  assert.equal(f.count('provider_calls',`attempt_id='${paid.id}' AND outcome='VALID'`),6);assert.equal(f.count('provider_calls',`attempt_id='${free.id}'`),0);
  const funding=await f.store.call('fundingTotals',{});assert.ok(funding.settledNanousd>0);assert.equal(funding.reservedNanousd+funding.unknownLiabilityNanousd,0);
  // A retried start returns the same attempt; the same ID in the other mode is refused rather than converting it.
  assert.equal((await (await f.request('/attempts',sponsor.cookie,f.start('s-1',{mode:'SPONSORED'}))).json()).id,paid.id);
  assert.equal((await f.request('/attempts',sponsor.cookie,f.start('s-1'))).status,409);
  assert.equal((await f.request('/attempts',practice.cookie,f.start('p-1',{mode:'SPONSORED'}))).status,409);
  assert.deepEqual([(await f.store.call('attempt',{id:paid.id}))!.mode,(await f.store.call('attempt',{id:free.id}))!.mode],['SPONSORED','PRACTICE']);
  // The mode survives restart and is what the operator sees.
  await f.restart();
  assert.equal((await (await f.request(`/attempts/${paid.id}`,sponsor.cookie)).json() as ChallengeAttemptView).mode,'SPONSORED');
  const overview=await (await f.request('/operator/overview',owner.cookie)).json() as OperatorOverview;
  assert.deepEqual(overview.attempts.map(a=>a.mode).sort(),['PRACTICE','SPONSORED']);
});

test('a client cannot choose the model, preset, budget or board, and cannot start sponsored play that is not offered',async t=>{
  const f=await setup(t),player=await f.user('player');
  for(const extra of [{mode:'LUNA'},{mode:'sponsored'},{mode:null},{mode:['SPONSORED']},{mode:'SPONSORED',model:'gpt-6-luna-pro'},{mode:'SPONSORED',preset:'other'},{mode:'SPONSORED',budgetUsd:100},
    {mode:'SPONSORED',maxCostNanousd:1},{board:{}},{mode:'SPONSORED',opponents:'HOLD'},{mode:'SPONSORED',persona:'aggressive'},{pricingVersion:'free'}])
  {
      // Stay under the per-account start rate limit so each refusal is the validation one.
      f.advance(10_000);
      assert.equal((await f.request('/attempts',player.cookie,f.start('tamper',extra))).status,400,JSON.stringify(extra));
    }
  assert.equal((await f.request('/attempts','',f.start('guest',{mode:'SPONSORED'}))).status,401);
  assert.deepEqual([f.count('attempts'),f.sent.length],[0,0]);
  const none=await setup(t,{transport:null}),other=await none.user('player');
  assert.deepEqual([(await none.catalog()).sponsoredPlay,(await none.catalog()).sponsoredMock],['NOT_OFFERED',false]);
  const refused=await none.request('/attempts',other.cookie,none.start('s-1',{mode:'SPONSORED'}));
  assert.equal(refused.status,409);assert.equal((await refused.json()).code,'SPONSORED_UNAVAILABLE');
  assert.equal((await none.request('/credit-request',other.cookie,{})).status,409);
  // Refusal consumed nothing: the same account still has all three starts today.
  for(const id of ['a','b','c']){const ok=await none.request('/attempts',other.cookie,none.start(id));assert.equal(ok.status,200);await none.request(`/attempts/${(await ok.json()).id}/abandon`,other.cookie,{});}
});

test('paused or unfunded sponsored play refuses new starts with a typed reason, offers the credit request once, and keeps practice open',async t=>{
  const f=await setup(t,{granted:0}),player=await f.user('player'),owner=await f.user('4242');
  // Offered, but the pool is empty: the first sponsored start pauses paid play instead of beginning an attempt.
  const refused=await f.request('/attempts',player.cookie,f.start('s-1',{mode:'SPONSORED'}));
  assert.equal(refused.status,409);assert.deepEqual([(await refused.json()).code,(await f.catalog()).sponsoredPlay],['SPONSORED_UNAVAILABLE','PAUSED']);
  assert.deepEqual([f.count('attempts'),f.count('start_receipts'),f.count('account_starts'),f.count('outbox')],[0,0,0,0]);
  assert.deepEqual(await (await f.request('/credit-request',player.cookie,{})).json(),{recorded:true,duplicate:false});
  assert.deepEqual(await (await f.request('/credit-request',player.cookie,{})).json(),{recorded:true,duplicate:true});
  assert.equal(f.count('outbox',"kind='CREDIT_REQUEST'"),1);
  assert.equal((await f.request('/attempts',player.cookie,f.start('p-1'))).status,200);
  // The owner grants funds and resumes; the same start request now succeeds.
  await f.store.call('grantFunding',{amountNanousd:1_000_000_000,authorizationRef:'owner-ref-0002',grantedBy:'test',now:f.now()});
  assert.equal((await f.request('/attempts',(await f.user('second')).cookie,f.start('s-2',{mode:'SPONSORED'}))).status,409);
  assert.equal((await f.request('/operator/paid',owner.cookie,{stopped:false})).status,200);
  const started=await f.request('/attempts',(await f.user('third')).cookie,f.start('s-3',{mode:'SPONSORED'}));
  assert.equal(started.status,200);assert.equal((await started.json()).mode,'SPONSORED');
  assert.equal((await f.catalog()).sponsoredPlay,'OPEN');
});

test('a sponsored phase that cannot be paid for waits with a clear notice and resumes after the owner acts; it never falls back to holds',async t=>{
  const f=await setup(t,{granted:6_000_000}),player=await f.user('player'),owner=await f.user('4242');
  const attempt=await (await f.request('/attempts',player.cookie,f.start('s-1',{mode:'SPONSORED'}))).json() as ChallengeAttemptView;
  // Lower the per-attempt cap below what six calls reserve and settle.
  await f.store.call('setFundingPolicy',{attemptCapNanousd:5_260_000,ceilingLimitNanousd:null,now:f.now()});
  const capped=await f.turn(player.cookie,attempt.id);
  assert.deepEqual([capped.board.season,capped.execution,capped.notice,capped.mode],['SPRING','RECOVERING','ATTEMPT_BUDGET','SPONSORED']);
  assert.equal((await f.store.call('paidState',{})).stopped,false);
  const bought=f.sent.length;assert.ok(bought>=0&&bought<6);
  const calls=await f.store.call('providerCallsForAttempt',{attemptId:attempt.id});
  assert.ok(calls.length>0);
  // The durable dispatch claim precedes transport invocation. Cancellation in that gap
  // still retains an unknown liability; the mock's sent counter cannot release it.
  const claimed=calls.filter(c=>c.dispatchedAt!==null);
  assert.ok(claimed.length>=bought&&claimed.length<=6);
  assert.ok(calls.every(c=>c.state==='FINISHED'));
  assert.equal((await f.store.call('attemptFunding',{attemptId:attempt.id})).heldNanousd,
    claimed.filter(c=>c.usage===null).reduce((sum,c)=>sum+c.maxCostNanousd,0));
  const saved=await f.store.call('providerDecisions',{operationId:calls[0].fence.operationId});
  const counts=new Map(saved.map(d=>[d.power,f.sent.filter(p=>p===d.power).length]));
  assert.equal((await (await f.request(`/attempts/${attempt.id}/reports`,player.cookie)).json()).reports.length,0);
  // Raising the cap and replenishing the mock pool are owner actions; unknown
  // dispatched liabilities remain held while recovery buys only missing answers.
  await f.store.call('grantFunding',{amountNanousd:1_000_000_000,authorizationRef:'owner-resume-0002',grantedBy:'test',now:f.now()});
  await f.store.call('setFundingPolicy',{attemptCapNanousd:1_000_000_000,ceilingLimitNanousd:null,now:f.now()});
  assert.equal((await (await f.request(`/attempts/${attempt.id}`,player.cookie)).json() as ChallengeAttemptView).notice,'SPONSORED_RETRY');
  await f.request('/operator/paid',owner.cookie,{stopped:true});
  assert.equal((await (await f.request(`/attempts/${attempt.id}`,player.cookie)).json() as ChallengeAttemptView).notice,'SPONSORED_PAUSED');
  assert.equal((await f.request(`/attempts/${attempt.id}/recover`,player.cookie,{})).status,200);
  assert.equal(f.sent.length,bought);
  await f.request('/operator/paid',owner.cookie,{stopped:false});
  const resumed=await (await f.request(`/attempts/${attempt.id}/recover`,player.cookie,{})).json() as ChallengeAttemptView;
  await f.service.attempts.wait(attempt.id);
  const done=await (await f.request(`/attempts/${attempt.id}`,player.cookie)).json() as ChallengeAttemptView;
  assert.ok(['RECOVERING','DECIDING','RESOLVING','ACCEPTING'].includes(resumed.execution));
  assert.deepEqual([done.board.season,done.execution,done.notice],['FALL','ACCEPTING',null]);
  assert.deepEqual([...new Set(f.sent)].sort(),['AUSTRIA','ENGLAND','FRANCE','GERMANY','ITALY','RUSSIA']);
  for(const [power,n] of counts)assert.equal(f.sent.filter(p=>p===power).length,n,'saved decisions are never bought again');
  // The player's saved orders were never reopened while it waited.
  assert.equal((await f.request(`/attempts/${attempt.id}/orders`,player.cookie,{revision:0,phaseId:attempt.phaseId,requestId:'change-my-mind',action:{phase:'ORDERS',orderIds:[]}})).status,409);
});

test('the mock transport setting is local-only, labels itself, and plays a sponsored attempt without any network call',async t=>{
  for(const env of [{DIPLOMACY_PROFILE:'showcase'},{DIPLOMACY_PROFILE:'private'},{DIPLOMACY_PROFILE:'local',NODE_ENV:'production'}])
    assert.throws(()=>readRuntimeConfig({...env,DIPLOMACY_LUNA_TRANSPORT:'mock',DIPLOMACY_AUTH_SESSION_SECRET:'x'.repeat(40)}),/DIPLOMACY_LUNA_TRANSPORT|DIPLOMACY_PROFILE/,JSON.stringify(env));
  assert.throws(()=>readRuntimeConfig({DIPLOMACY_LUNA_TRANSPORT:'live'}),/DIPLOMACY_LUNA_TRANSPORT/);
  assert.equal(readRuntimeConfig({}).lunaTransport,'none');
  const outbound:string[]=[],realFetch=globalThis.fetch;
  globalThis.fetch=((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{const url=String(input instanceof Request?input.url:input);if(!url.startsWith('http://127.0.0.1:'))outbound.push(url);return realFetch(input,init);}) as typeof fetch;
  t.after(()=>{globalThis.fetch=realFetch;});
  // Local profile with the mock selected by configuration, not injected.
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-mock-')),store=await Store.open(join(dir,'game.sqlite')),now=Date.parse('2027-01-01T12:00:00Z');
  const env={DIPLOMACY_PROFILE:'local',DIPLOMACY_LUNA_TRANSPORT:'mock',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4)},config=readRuntimeConfig(env);
  const auth=new AuthService(store,config,env,undefined,()=>now),service=await ChallengeService.open(store,config,()=>now);
  const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api',service.router(auth));
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address==='object');
  const player=await store.call('identity',{provider:'github',subject:'local',displayName:'Test',now}),cookie=`${auth.cookieName}=${newToken()}`;
  await store.call('createSession',{tokenHash:auth.tokenHash(cookie)!,playerId:player.id,now,expiresAt:now+86_400_000});
  await store.call('grantFunding',{amountNanousd:1_000_000_000,authorizationRef:'local-mock-0001',grantedBy:'test',now});
  const call=(route:string,body?:unknown)=>realFetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const catalog=await (await call('/challenges')).json() as ChallengeCatalog;
  assert.deepEqual([catalog.sponsoredPlay,catalog.sponsoredMock],['OPEN',true]);
  const attempt=await (await call('/attempts',{requestId:'m-1',challengeId:'tunis-expedition',challengeVersion:1,mode:'SPONSORED'})).json() as ChallengeAttemptView;
  assert.equal(attempt.challenge.opponentLabel,'Mock Luna opponents · development stand-in, no provider calls');
  const legal=await (await call(`/attempts/${attempt.id}/legal`)).json() as ChallengeLegalCatalog;
  await call(`/attempts/${attempt.id}/orders`,{revision:0,phaseId:attempt.phaseId,requestId:'o-1',action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}});
  await service.attempts.wait(attempt.id);
  assert.equal(((await (await call(`/attempts/${attempt.id}`)).json()) as ChallengeAttemptView).board.season,'FALL');
  assert.equal((await store.call('fundingTotals',{})).settledNanousd>0,true);
  assert.deepEqual(outbound,[]);
});
