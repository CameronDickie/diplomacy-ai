import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { Store,hashToken,newToken } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { OperatorService } from '../operator/OperatorService.js';
import { Notifier,localDelivery,resendDelivery,type Delivery } from '../operator/Notifier.js';
import { OUTBOX_MAX_ATTEMPTS,outboxBackoffMs } from '../storage/outbox.js';
import { AttemptService,offlineDecisions } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseDecisions,PhaseJob } from '../attempts/types.js';
import type { ProviderCallIntent,ProviderUsage } from '../providers/accounting.js';
import type { ChallengeAttemptView,ChallengeCatalog,ChallengeLegalCatalog,OperatorAttemptDetail,OperatorOverview } from '@diplomacy/shared';

const usage:ProviderUsage={inputTokens:100,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:50,reasoningTokens:0,costNanousd:12345};
async function setup(t:test.TestContext,build?:(store:Store,now:()=>number)=>AttemptService){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-operator-'));let now=Date.parse('2027-01-01T12:00:00Z');
  const path=join(dir,'game.sqlite');let store=await Store.open(path);
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4),DIPLOMACY_ADMIN_GITHUB_USER_IDS:'4242'};
  const config=readRuntimeConfig(env),auth=new AuthService(store,config,env,undefined,()=>now);
  const service=await ChallengeService.open(store,config,()=>now);
  await store.call('grantFunding',{amountNanousd:1_000_000_000,authorizationRef:'test-grant-0001',grantedBy:'test',now});
  const attempts=build?.(store,()=>now)??service.attempts;
  const operator=new OperatorService(store,config,attempts,()=>now,localDelivery);
  const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api/operator',operator.router(auth));app.use('/api',service.router(auth));
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const request=(route:string,cookie='',body?:unknown,origin:string|null=config.returnOrigin)=>fetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(origin?{Origin:origin}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function user(subject:string,provider:'github'|'google'='github'){
    const player=await store.call('identity',{provider,subject,displayName:`Private name ${subject}`,now});
    const cookie=`${auth.cookieName}=${newToken()}`,tokenHash=auth.tokenHash(cookie)!;
    await store.call('createSession',{tokenHash,playerId:player.id,now,expiresAt:now+7*86_400_000});return {player,cookie,tokenHash};
  }
  const start=(requestId:string)=>({requestId,challengeId:'tunis-expedition',challengeVersion:1});
  async function play(cookie:string,requestId:string){
    const attempt=await (await request('/attempts',cookie,start(requestId))).json() as ChallengeAttemptView;
    const legal=await (await request(`/attempts/${attempt.id}/legal`,cookie)).json() as ChallengeLegalCatalog;
    await request(`/attempts/${attempt.id}/orders`,cookie,{revision:attempt.revision,phaseId:attempt.phaseId,requestId:'orders-1',action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}});
    await service.attempts.wait(attempt.id);return attempt;
  }
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await operator.close();if(attempts!==service.attempts)await attempts.close();await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  return {path,get store(){return store;},service,operator,auth,attempts,request,user,start,play,config,now:()=>now,advance:(ms:number)=>{now+=ms;},
    async reopen(){await store.close();store=await Store.open(path);return store;}};
}
async function phase(store:Store,playerId:string,id:string,now:number){
  const attempt=await store.call('createAttempt',{id,playerId,challengeId:'tunis-expedition',challengeVersion:1,reconnectTokenHash:hashToken(id),now});
  const {job}=await store.call('beginPhase',{id,playerId,expectedRevision:0,phaseId:attempt.phaseId,operationId:`${id}-phase`,requestId:'orders',action:{phase:'ORDERS',orderIds:['CON|HOLD','SMY|HOLD','ANK|HOLD']},now});
  const intent=(call:string):ProviderCallIntent=>({id:call,fence:{operationId:job.operationId,attemptId:job.attemptId,phaseId:job.phaseId,revision:job.revision},power:'FRANCE',provider:'OPENAI',model:'gpt-6-luna',role:'ORDERS',pricingVersion:'mock-price-v1',requestHash:hashToken(call),maxCostNanousd:100000});
  return {attempt,job,intent};
}

test('operator routes reject guests, ordinary players, look-alike identities, revoked sessions and origin-less writes',async t=>{
  const f=await setup(t),owner=await f.user('4242'),player=await f.user('player'),google=await f.user('4242','google');
  const attempt=await f.play(player.cookie,'start-1');
  const routes:Array<[string,unknown?]>=[['/operator/overview'],[`/operator/attempts/${attempt.id}`],['/operator/paid',{stopped:true}],[`/operator/attempts/${attempt.id}/stop`,{}],[`/operator/players/${player.player.id}/ban`,{banned:true}]];
  for(const [route,body] of routes){
    assert.equal((await f.request(route,'',body)).status,401,route);
    for(const who of [player,google]){const denied=await f.request(route,who.cookie,body);assert.equal(denied.status,403,route);assert.deepEqual(await denied.json(),{code:'OPERATOR_REQUIRED'});}
  }
  // None of the refused writes took effect.
  assert.equal((await f.store.call('paidState',{})).stopped,false);assert.equal((await f.store.call('attempt',{id:attempt.id}))!.lifecycle,'ACTIVE');
  assert.equal((await f.request('/operator/paid',owner.cookie,{stopped:true},null)).status,403);
  assert.equal((await f.request('/operator/paid',owner.cookie,{stopped:true},'https://evil.example')).status,403);
  assert.equal((await f.request('/operator/overview',owner.cookie)).status,200);
  assert.equal((await f.request('/operator/paid',owner.cookie,{stopped:'yes'})).status,400);
  assert.equal((await f.request('/operator/paid',owner.cookie,{stopped:true,budgetUsd:999})).status,400);
  assert.equal((await f.request(`/operator/players/${owner.player.id}/ban`,owner.cookie,{banned:true})).status,400);
  assert.equal((await f.request('/operator/attempts/missing',owner.cookie)).status,404);
  await f.store.call('revokeSession',{tokenHash:owner.tokenHash,now:f.now()});
  assert.equal((await f.request('/operator/overview',owner.cookie)).status,401);
  assert.equal((await f.request('/operator/paid',owner.cookie,{stopped:true})).status,401);
});

test('overview and spectator view reconcile with the ledger and expose no identity, session or provider internals',async t=>{
  const f=await setup(t),owner=await f.user('4242'),player=await f.user('player');
  const played=await f.play(player.cookie,'start-1');
  const a=await phase(f.store,player.player.id,'ledger-a',f.now()),b=await phase(f.store,owner.player.id,'ledger-b',f.now());
  for(const [p,ids] of [[a,['a1','a2']],[b,['b1']]] as const)for(const id of ids){await f.store.call('prepareProviderCall',{intent:p.intent(id),now:f.now()});await f.store.call('dispatchProviderCall',{id,now:f.now()});}
  await f.store.call('receiveProviderCall',{id:'a1',responseId:'resp_a1',usage,now:f.now()});
  await f.store.call('receiveProviderCall',{id:'b1',responseId:'resp_b1',usage:{...usage,costNanousd:500},now:f.now()});
  const response=await f.request('/operator/overview',owner.cookie),text=await response.text(),overview=JSON.parse(text) as OperatorOverview;
  const perOperation=await Promise.all([a,b].map(p=>f.store.call('providerCallTotals',{operationId:p.job.operationId})));
  assert.equal(overview.spend.knownCostNanousd,perOperation.reduce((n,x)=>n+x.knownCostNanousd,0));assert.equal(overview.spend.knownCostNanousd,12845);
  assert.equal(overview.spend.unresolvedLiabilityNanousd,perOperation.reduce((n,x)=>n+x.unresolvedLiabilityNanousd,0));assert.equal(overview.spend.unresolvedLiabilityNanousd,100000);
  assert.equal(overview.spend.calls,3);assert.equal(overview.spend.unresolvedCalls,1);
  // The ledger agrees with the detailed records: settled = known cost, the unanswered call is still in flight.
  assert.deepEqual([overview.funding.settledNanousd,overview.funding.reservedNanousd,overview.funding.unknownLiabilityNanousd,overview.reservedNanousd],[12845,100000,0,100000]);
  assert.equal(overview.funding.availableNanousd,overview.funding.ceilingNanousd-12845-100000);assert.equal(overview.paidConfigured,false);assert.equal(overview.notifyMode,'outbox');
  assert.equal(overview.activeAttempts,3);assert.equal(overview.maxActiveAttempts,3);assert.equal(overview.attempts.length,3);
  for(const secret of ['Private name','4242','"subject"','displayName','tokenHash','token_hash','reconnect','requestHash','intent','decisions','humanAction'])assert.ok(!text.includes(secret),secret);
  const detailText=await (await f.request(`/operator/attempts/${played.id}`,owner.cookie)).text(),detail=JSON.parse(detailText) as OperatorAttemptDetail;
  assert.deepEqual(detail.reports,(await (await f.request(`/attempts/${played.id}/reports`,player.cookie)).json()).reports);
  assert.equal(detail.attempt.playerId,player.player.id);assert.equal(detail.board.season,'FALL');assert.equal(detail.spend.calls,0);
  for(const secret of ['Private name','"subject"','displayName','reconnect','fingerprint','orderIds'])assert.ok(!detailText.includes(secret),secret);
  assert.equal((await (await f.request(`/operator/attempts/${a.attempt.id}`,owner.cookie)).json() as OperatorAttemptDetail).spend.unresolvedLiabilityNanousd,100000);
  const audited=(await (await f.request('/operator/overview',owner.cookie)).json() as OperatorOverview).audit;
  assert.deepEqual(audited.map(x=>[x.action,x.target,x.operatorId]),[['SPECTATE',a.attempt.id,owner.player.id],['SPECTATE',played.id,owner.player.id]]);
  const catalog=await (await f.request('/challenges')).json() as ChallengeCatalog;assert.equal(catalog.capacity,'FULL');assert.equal(catalog.sponsoredPlay,'NOT_OFFERED');
});

test('paid stop is durable, blocks new prepare and dispatch including recovered work, and still reconciles late bills',async t=>{
  const f=await setup(t),owner=await f.user('4242'),player=await f.user('player');
  const p=await phase(f.store,player.player.id,'paid-attempt',f.now());
  await f.store.call('prepareProviderCall',{intent:p.intent('prepared'),now:f.now()});
  await f.store.call('prepareProviderCall',{intent:p.intent('in-flight'),now:f.now()});await f.store.call('dispatchProviderCall',{id:'in-flight',now:f.now()});
  const stopped=await (await f.request('/operator/paid',owner.cookie,{stopped:true})).json();
  assert.deepEqual({stopped:stopped.stopped,episode:stopped.episode},{stopped:true,episode:1});
  await assert.rejects(f.store.call('prepareProviderCall',{intent:p.intent('new'),now:f.now()}),{code:'STORE_CONFLICT'});
  await assert.rejects(f.store.call('dispatchProviderCall',{id:'prepared',now:f.now()}),{code:'STORE_CONFLICT'});
  assert.equal((await f.store.call('receiveProviderCall',{id:'in-flight',responseId:'resp_late',usage,now:f.now()})).usage!.costNanousd,12345);
  // Repeating the stop is not a new episode, and the switch survives a restart of the store.
  assert.equal((await (await f.request('/operator/paid',owner.cookie,{stopped:true})).json()).episode,1);
  const reopened=await Store.open(f.path);
  try{assert.deepEqual({...await reopened.call('paidState',{}),updatedAt:0},{stopped:true,episode:1,updatedAt:0});
    await assert.rejects(reopened.call('dispatchProviderCall',{id:'prepared',now:f.now()}),{code:'STORE_CONFLICT'});}finally{await reopened.close();}
  assert.equal((await (await f.request('/operator/paid',owner.cookie,{stopped:false})).json()).stopped,false);
  assert.equal((await f.store.call('dispatchProviderCall',{id:'prepared',now:f.now()})).state,'DISPATCHED');
  assert.equal((await (await f.request('/operator/paid',owner.cookie,{stopped:true})).json()).episode,2);
  // Recovered work gets a fresh fence, and the stop still refuses it until the operator resumes.
  const recovered=await f.store.call('recoverPhase',{fence:p.job,now:f.now()});
  const retry={...p.intent('recovered'),fence:{...p.intent('recovered').fence,revision:recovered.revision}};
  await assert.rejects(f.store.call('prepareProviderCall',{intent:retry,now:f.now()}),{code:'STORE_CONFLICT'});
  await f.request('/operator/paid',owner.cookie,{stopped:false});
  assert.equal((await f.store.call('prepareProviderCall',{intent:retry,now:f.now()})).state,'PREPARED');
  assert.deepEqual((await (await f.request('/operator/overview',owner.cookie)).json() as OperatorOverview).audit.map(x=>x.action),['PAID_RESUME','PAID_STOP','PAID_RESUME','PAID_STOP','PAID_STOP']);
});

test('operator stop and ban abort in-flight work, revoke access and leave nothing for the phase to commit',async t=>{
  let started!:(context:{job:PhaseJob;signal:AbortSignal})=>void;const rules=new PhaseRules(),fallback=offlineDecisions(rules);
  const contexts:Array<{job:PhaseJob;signal:AbortSignal}>=[];let waiting=new Promise<{job:PhaseJob;signal:AbortSignal}>(done=>{started=done;});
  const f=await setup(t,(store,now)=>new AttemptService(store,{decide:async context=>{contexts.push(context);started(context);return new Promise<PhaseDecisions>(()=>{});},recover:fallback.recover},rules,{now}));
  const owner=await f.user('4242'),one=await f.user('one'),two=await f.user('two');
  const revoked:string[]=[];f.auth.onRevoke(hash=>revoked.push(hash));
  const orderIds=async(board:Parameters<PhaseRules['legal']>[0])=>(await rules.legal(board,'TURKEY',new AbortController().signal)).filter(o=>o.order.type==='HOLD').map(o=>o.id);
  async function inFlight(playerId:string,id:string){
    const attempt=await f.store.call('createAttempt',{id,playerId,challengeId:'tunis-expedition',challengeVersion:1,reconnectTokenHash:hashToken(id),now:f.now()});
    await f.attempts.submit({attemptId:id,playerId,revision:0,phaseId:attempt.phaseId,requestId:'orders',action:{phase:'ORDERS',orderIds:await orderIds(attempt.board)}});
    const context=await waiting;waiting=new Promise(done=>{started=done;});return context;
  }
  const first=await inFlight(one.player.id,'stop-me');
  assert.deepEqual(await (await f.request('/operator/attempts/stop-me/stop',owner.cookie,{})).json(),{id:'stop-me',lifecycle:'STOPPED'});
  assert.equal(first.signal.aborted,true);await f.attempts.wait('stop-me');
  const seen=await (await f.request('/attempts/stop-me',one.cookie)).json() as ChallengeAttemptView;
  assert.equal(seen.lifecycle,'STOPPED');assert.equal(seen.receipt?.status,'FAILED');
  assert.equal((await f.store.call('reports',{attemptId:'stop-me'})).length,0);
  // Stopping again is harmless and the player may start afresh.
  assert.equal((await f.request('/operator/attempts/stop-me/stop',owner.cookie,{})).status,200);
  const second=await inFlight(two.player.id,'ban-me');
  assert.deepEqual(await (await f.request(`/operator/players/${two.player.id}/ban`,owner.cookie,{banned:true})).json(),{playerId:two.player.id,banned:true});
  assert.equal(second.signal.aborted,true);await f.attempts.wait('ban-me');
  assert.deepEqual(revoked,[two.tokenHash]);
  assert.equal((await f.request('/attempts',two.cookie)).status,401);
  assert.equal((await f.store.call('attempt',{id:'ban-me'}))!.lifecycle,'STOPPED');
  const intent:ProviderCallIntent={id:'after-ban',fence:{operationId:second.job.operationId,attemptId:'ban-me',phaseId:second.job.phaseId,revision:second.job.revision},power:'FRANCE',provider:'OPENAI',model:'gpt-6-luna',role:'ORDERS',pricingVersion:'mock-price-v1',requestHash:hashToken('x'),maxCostNanousd:100000};
  await assert.rejects(f.store.call('prepareProviderCall',{intent,now:f.now()}),{code:'STORE_CONFLICT'});
  await assert.rejects(f.store.call('createSession',{tokenHash:hashToken('again'),playerId:two.player.id,now:f.now(),expiresAt:f.now()+1000}),{code:'STORE_FORBIDDEN'});
  assert.equal((await f.request(`/operator/players/${two.player.id}/ban`,owner.cookie,{banned:false})).status,200);
  await f.store.call('createSession',{tokenHash:hashToken('again'),playerId:two.player.id,now:f.now(),expiresAt:f.now()+1000});
  assert.equal(contexts.length,2);
});

test('start and credit-request notices are recorded once per logical event',async t=>{
  const f=await setup(t),owner=await f.user('4242'),player=await f.user('player'),other=await f.user('other');
  const copies=await Promise.all([f.request('/attempts',player.cookie,f.start('start-1')),f.request('/attempts',player.cookie,f.start('start-1')),f.request('/attempts',player.cookie,f.start('start-1'))]);
  const id=(await copies[0].json()).id;
  const outbox=async()=>(await (await f.request('/operator/overview',owner.cookie)).json() as OperatorOverview).outbox;
  assert.deepEqual((await outbox()).recent.map(m=>[m.kind,m.dedupeKey,m.state]),[['ATTEMPT_STARTED',`start:${id}`,'PENDING']]);
  // Sponsored play is not offered in this build, so the public route refuses rather than queueing noise.
  assert.equal((await f.request('/credit-request',player.cookie,{})).status,409);assert.equal((await f.request('/credit-request','',{})).status,401);
  await assert.rejects(f.store.call('requestCredit',{playerId:player.player.id,now:f.now()}),{code:'STORE_CONFLICT'});
  await f.request('/operator/paid',owner.cookie,{stopped:true});
  assert.deepEqual(await f.store.call('requestCredit',{playerId:player.player.id,now:f.now()}),{recorded:true,duplicate:false});
  assert.deepEqual(await f.store.call('requestCredit',{playerId:player.player.id,now:f.now()+5}),{recorded:true,duplicate:true});
  assert.deepEqual(await f.store.call('requestCredit',{playerId:other.player.id,now:f.now()}),{recorded:true,duplicate:false});
  await f.request('/operator/paid',owner.cookie,{stopped:false});await f.request('/operator/paid',owner.cookie,{stopped:true});
  assert.deepEqual(await f.store.call('requestCredit',{playerId:player.player.id,now:f.now()}),{recorded:true,duplicate:false});
  const all=await outbox();
  assert.deepEqual(all.recent.map(m=>m.dedupeKey).sort(),[`credit:${other.player.id}:1`,`credit:${player.player.id}:1`,`credit:${player.player.id}:2`,`start:${id}`].sort());
  assert.ok(!JSON.stringify(all).includes('Private name'));
  await f.service.attempts.banPlayer(other.player.id);
  await assert.rejects(f.store.call('requestCredit',{playerId:other.player.id,now:f.now()}),{code:'STORE_FORBIDDEN'});
});

test('delivery retries with backoff, never sends a settled message twice and never blocks a phase commit',async t=>{
  const f=await setup(t),player=await f.user('player');
  let mode:'fail'|'ok'|'hang'='hang';const sent:string[]=[];let release!:()=>void;
  const delivery:Delivery={channel:'resend',send:async(message,signal)=>{
    sent.push(message.dedupeKey);
    if(mode==='fail')throw new Error('raw provider detail that must not be stored');
    if(mode==='hang')await new Promise<void>((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
  }};
  const notifier=new Notifier(f.store,delivery,f.now,60_000);t.after(()=>notifier.close());
  const attempt=await (await f.request('/attempts',player.cookie,f.start('start-1'))).json() as ChallengeAttemptView;
  const key=`start:${attempt.id}`,hanging=notifier.drain();
  while(sent.length===0)await new Promise(done=>setTimeout(done,5));
  // A second drain joins the first instead of sending again, and the game carries on meanwhile.
  assert.equal(notifier.drain(),notifier.drain());
  const legal=await (await f.request(`/attempts/${attempt.id}/legal`,player.cookie)).json() as ChallengeLegalCatalog;
  assert.equal((await f.request(`/attempts/${attempt.id}/orders`,player.cookie,{revision:attempt.revision,phaseId:attempt.phaseId,requestId:'orders-1',action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}})).status,200);
  await f.service.attempts.wait(attempt.id);
  assert.equal((await f.store.call('attempt',{id:attempt.id}))!.board.season,'FALL');
  mode='fail';release();
  // The hung send resolved, so that message is delivered exactly once.
  assert.equal(await hanging,1);assert.deepEqual(sent,[key]);
  assert.equal(await notifier.drain(),0);assert.deepEqual(sent,[key]);
  const second=await (async()=>{await f.request(`/attempts/${attempt.id}/abandon`,player.cookie,{});return (await (await f.request('/attempts',player.cookie,f.start('start-2'))).json()).id as string;})();
  const key2=`start:${second}`;
  assert.equal(await notifier.drain(),0);assert.deepEqual(sent,[key,key2]);
  const row=async()=>(await f.store.call('operatorOverview',{})).outbox.recent.find(m=>m.dedupeKey===key2)!;
  assert.deepEqual([(await row()).state,(await row()).attempts,(await row()).lastError],['PENDING',1,'DELIVERY_FAILED']);
  // Not due again until its backoff has elapsed.
  f.advance(outboxBackoffMs(1)-1);assert.equal(await notifier.drain(),0);assert.equal(sent.length,2);
  f.advance(1);assert.equal(await notifier.drain(),0);assert.equal(sent.length,3);assert.equal((await row()).attempts,2);
  mode='ok';f.advance(outboxBackoffMs(2));assert.equal(await notifier.drain(),1);
  assert.deepEqual([(await row()).state,(await row()).channel,(await row()).lastError],['SENT','resend',null]);
  f.advance(86_400_000);assert.equal(await notifier.drain(),0);assert.equal(sent.filter(k=>k===key2).length,3);
});

test('an unknown delivery outcome is retried under the same idempotency key and a dead message stops retrying',async t=>{
  const f=await setup(t),player=await f.user('player');
  const attempt=await (await f.request('/attempts',player.cookie,f.start('start-1'))).json() as ChallengeAttemptView;
  // A sender that claimed the message and then died: nothing settles it.
  const [lost]=await f.store.call('claimOutbox',{now:f.now(),limit:10,leaseMs:60_000});
  assert.equal(lost.dedupeKey,`start:${attempt.id}`);
  assert.deepEqual(await f.store.call('claimOutbox',{now:f.now()+59_999,limit:10,leaseMs:60_000}),[]);
  const requests:Array<{url:string;headers:Record<string,string>;body:string}>=[];let status=500;
  const mock=(async(url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{requests.push({url:String(url),headers:init!.headers as Record<string,string>,body:String(init!.body)});return new Response('{"secret":"provider body"}',{status});}) as typeof fetch;
  const notifier=new Notifier(f.store,resendDelivery({apiKey:'test-key-not-real',from:'Game <game@example.test>',to:'owner@example.test'},mock),f.now);t.after(()=>notifier.close());
  f.advance(60_000);assert.equal(await notifier.drain(),0);
  assert.equal(requests[0].url,'https://api.resend.com/emails');assert.equal(requests[0].headers['Idempotency-Key'],`start:${attempt.id}`);assert.equal(requests[0].headers.Authorization,'Bearer test-key-not-real');
  const body=JSON.parse(requests[0].body);assert.deepEqual(body.to,['owner@example.test']);assert.match(body.text,new RegExp(attempt.id));assert.ok(!requests[0].body.includes('Private name'));
  let row=(await f.store.call('operatorOverview',{})).outbox.recent[0];
  assert.deepEqual([row.state,row.attempts,row.lastError],['PENDING',2,'HTTP_500']);assert.ok(!JSON.stringify(row).includes('provider body'));
  for(let i=row.attempts;i<OUTBOX_MAX_ATTEMPTS;i++){f.advance(3_600_000);await notifier.drain();}
  row=(await f.store.call('operatorOverview',{})).outbox.recent[0];
  assert.deepEqual([row.state,row.attempts],['FAILED',OUTBOX_MAX_ATTEMPTS]);
  status=200;f.advance(86_400_000);assert.equal(await notifier.drain(),0);assert.equal(requests.length,OUTBOX_MAX_ATTEMPTS-1);
  assert.ok(requests.every(r=>r.headers['Idempotency-Key']===`start:${attempt.id}`));
  // A late success for an already-final message does not reopen it.
  assert.equal((await f.store.call('settleOutbox',{id:row.id,ok:true,channel:'resend',now:f.now()})).state,'FAILED');
  const counts=(await f.store.call('operatorOverview',{})).outbox.counts;assert.deepEqual(counts,{PENDING:0,SENDING:0,SENT:0,FAILED:1});
});
