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
import { Store,hashToken,newToken } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { AttemptService,offlineDecisions } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseDecisions,PhaseJob } from '../attempts/types.js';
import type { ProviderCallIntent,ProviderUsage } from '../providers/accounting.js';
import type { ChallengeAttemptView,ChallengeLegalCatalog } from '@diplomacy/shared';

const DAY=86_400_000;
const usage:ProviderUsage={inputTokens:100,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:50,reasoningTokens:0,costNanousd:12345};
async function setup(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-retention-'));let now=Date.parse('2027-01-01T12:00:00Z');
  const path=join(dir,'game.sqlite'),store=await Store.open(path);
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4)};
  const config=readRuntimeConfig(env),auth=new AuthService(store,config,env,undefined,()=>now);
  const service=await ChallengeService.open(store,config,()=>now);
  await store.call('grantFunding',{amountNanousd:1_000_000_000,authorizationRef:'test-grant-0001',grantedBy:'test',now});
  const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api/auth',auth.router());app.use('/api',service.router(auth));
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const request=(route:string,cookie='',body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function user(subject:string){
    const player=await store.call('identity',{provider:'github',subject,displayName:'Private display name',now});
    const cookie=`${auth.cookieName}=${newToken()}`,tokenHash=auth.tokenHash(cookie)!;
    await store.call('createSession',{tokenHash,playerId:player.id,now,expiresAt:now+7*DAY});return {player,cookie,tokenHash};
  }
  const start=(requestId:string)=>({requestId,challengeId:'tunis-expedition',challengeVersion:1});
  const today=async(requestId:string)=>{const card=(await (await request('/challenges')).json()).challenges[0];return {requestId,challengeId:card.id as string,challengeVersion:card.version as number};};
  async function play(cookie:string,requestId:string){
    const attempt=await (await request('/attempts',cookie,start(requestId))).json() as ChallengeAttemptView;
    const legal=await (await request(`/attempts/${attempt.id}/legal`,cookie)).json() as ChallengeLegalCatalog;
    assert.equal((await request(`/attempts/${attempt.id}/orders`,cookie,{revision:attempt.revision,phaseId:attempt.phaseId,requestId:'orders-1',action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}})).status,200);
    await service.attempts.wait(attempt.id);return attempt;
  }
  const count=(table:string,where='1=1')=>{const db=new DatabaseSync(path,{readOnly:true});try{return Number(db.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get()!.n);}finally{db.close();}};
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,path,store,service,auth,request,user,start,today,play,count,config,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}

test('retention removes diagnostics then results exactly at their boundaries, never an active attempt',async t=>{
  const f=await setup(t),owner=await f.user('owner'),other=await f.user('other');
  const attempt=await f.play(owner.cookie,'start-1');
  const live=await (await f.request('/attempts',other.cookie,f.start('start-live'))).json() as ChallengeAttemptView;
  f.advance(60_000);
  const closed=await (await f.request(`/attempts/${attempt.id}/abandon`,owner.cookie,{})).json() as ChallengeAttemptView;
  const ended=f.now();assert.equal(closed.lifecycle,'ABANDONED');
  assert.equal(f.count('phase_jobs'),1);assert.equal(f.count('receipts'),1);assert.equal(f.count('reports'),1);
  const sweep=(resultBefore:number,diagnosticBefore:number)=>f.store.call('sweepRetention',{now:ended+40*DAY,resultBefore,diagnosticBefore,limit:200});
  assert.deepEqual(await sweep(ended-1,ended-1),{attempts:0,diagnostics:0,sessions:0,receipts:0,more:false});
  assert.equal((await sweep(ended-1,ended)).diagnostics,1);
  assert.equal(f.count('phase_jobs'),0);assert.equal(f.count('receipts'),0);assert.equal(f.count('reports'),1);
  // The saved result is still readable once its diagnostics are gone.
  const kept=await (await f.request(`/attempts/${attempt.id}`,owner.cookie)).json() as ChallengeAttemptView;
  assert.equal(kept.lifecycle,'ABANDONED');assert.equal(kept.receipt,null);
  assert.equal((await (await f.request(`/attempts/${attempt.id}/reports`,owner.cookie)).json()).reports.length,1);
  assert.equal((await sweep(ended-1,ended)).attempts,0);
  assert.equal((await sweep(ended,ended)).attempts,1);
  assert.equal(f.count('attempts',`id='${attempt.id}'`),0);assert.equal(f.count('reports'),0);assert.equal(f.count('start_receipts'),1);
  assert.equal((await f.request(`/attempts/${attempt.id}`,owner.cookie)).status,404);
  // Every cutoff is far past the active attempt's last write, and it still survives.
  await f.store.call('sweepRetention',{now:ended+400*DAY,resultBefore:ended+399*DAY,diagnosticBefore:ended+399*DAY,limit:200});
  assert.equal((await f.store.call('attempt',{id:live.id}))!.lifecycle,'ACTIVE');
  await assert.rejects(f.store.call('sweepRetention',{now:ended,resultBefore:ended,diagnosticBefore:ended-1,limit:200}),{code:'STORE_INVALID'});
  await assert.rejects(f.store.call('sweepRetention',{now:ended,resultBefore:ended,diagnosticBefore:ended,limit:501}),{code:'STORE_INVALID'});
});

test('the service sweep applies configured retention on its own and a past day never restores starts',async t=>{
  const f=await setup(t),owner=await f.user('owner');
  assert.equal(f.config.resultRetentionDays,30);assert.equal(f.config.diagnosticRetentionDays,7);
  const attempt=await f.play(owner.cookie,'start-1');
  await f.request(`/attempts/${attempt.id}/abandon`,owner.cookie,{});
  for(const id of ['start-2','start-3'])await f.request(`/attempts/${(await (await f.request('/attempts',owner.cookie,f.start(id))).json()).id}/abandon`,owner.cookie,{});
  assert.equal((await (await f.request('/attempts',owner.cookie,f.start('start-4'))).json()).code,'DAILY_LIMIT');
  f.advance(7*DAY+3_600_000);
  const renewed=await f.user('owner');
  assert.equal((await (await f.request('/attempts',renewed.cookie)).json()).attempts.length,3);
  assert.equal(f.count('phase_jobs'),0);assert.equal(f.count('receipts'),0);assert.equal(f.count('account_starts'),0);
  assert.equal(f.count('sessions',`token_hash='${owner.tokenHash}'`),1);
  f.advance(23*DAY+3_600_000);
  const later=await f.user('owner');
  assert.deepEqual(await (await f.request('/attempts',later.cookie)).json(),{attempts:[],next:null});
  // Sessions are kept for the diagnostic window after they expire, then removed.
  assert.equal(f.count('sessions',`token_hash='${owner.tokenHash}'`),0);
  assert.equal(f.count('attempts'),0);assert.equal(f.count('reports'),0);
});

test('retention and restart keep known spend and unresolved liabilities after their attempt is removed',async t=>{
  const f=await setup(t),owner=await f.user('owner');let now=f.now();
  const attempt=await f.store.call('createAttempt',{id:'ledger-attempt',playerId:owner.player.id,challengeId:'tunis-expedition',challengeVersion:1,reconnectTokenHash:hashToken('t'),now});
  const {job}=await f.store.call('beginPhase',{id:attempt.id,playerId:owner.player.id,expectedRevision:0,phaseId:attempt.phaseId,operationId:'ledger-phase',requestId:'orders',action:{phase:'ORDERS',orderIds:['CON|HOLD','SMY|HOLD','ANK|HOLD']},now});
  const intent=(id:string):ProviderCallIntent=>({id,fence:{operationId:job.operationId,attemptId:job.attemptId,phaseId:job.phaseId,revision:job.revision},power:'FRANCE',provider:'OPENAI',model:'gpt-6-luna',role:'ORDERS',pricingVersion:'mock-price-v1',requestHash:hashToken(id),maxCostNanousd:100000});
  for(const id of ['known','unknown']){await f.store.call('prepareProviderCall',{intent:intent(id),now});await f.store.call('dispatchProviderCall',{id,now});}
  await f.store.call('receiveProviderCall',{id:'known',responseId:'resp_known',usage,now});
  const before=await f.store.call('providerCallTotals',{operationId:job.operationId});
  assert.equal(before.knownCostNanousd,12345);assert.equal(before.unresolvedLiabilityNanousd,100000);
  await f.store.call('terminateAttempt',{id:attempt.id,playerId:owner.player.id,lifecycle:'EXPIRED',now});
  // No paid job begins after closure: the same fence can no longer prepare or dispatch.
  await assert.rejects(f.store.call('prepareProviderCall',{intent:intent('after-close'),now}),{code:'STORE_CONFLICT'});
  now+=400*DAY;
  assert.equal((await f.store.call('sweepRetention',{now,resultBefore:now-30*DAY,diagnosticBefore:now-7*DAY,limit:200})).attempts,1);
  assert.equal(await f.store.call('attempt',{id:attempt.id}),null);
  assert.deepEqual(await f.store.call('providerCallTotals',{operationId:job.operationId}),before);
  // A late bill for the removed attempt still reconciles.
  await f.store.call('receiveProviderCall',{id:'unknown',responseId:'resp_unknown',usage,now});
  const settled=await f.store.call('providerCallTotals',{operationId:job.operationId});
  assert.equal(settled.knownCostNanousd,24690);assert.equal(settled.unresolvedLiabilityNanousd,0);
  const copy=join(f.dir,'backup.sqlite');await f.store.call('backup',{destination:copy});
  const restored=await Store.open(join(f.dir,'restored.sqlite'),copy);
  try{assert.deepEqual(await restored.call('providerCallTotals',{operationId:job.operationId}),settled);}finally{await restored.close();}
});

test('account deletion removes identity, sessions and private history, keeps today\'s start count and leaves others alone',async t=>{
  const f=await setup(t),owner=await f.user('owner'),other=await f.user('other');
  const revoked:string[]=[];f.auth.onRevoke(hash=>revoked.push(hash));
  const attempt=await f.play(owner.cookie,'start-1');
  const theirs=await (await f.request('/attempts',other.cookie,f.start('start-other'))).json() as ChallengeAttemptView;
  assert.equal((await f.request('/account/delete','',{confirm:'DELETE'})).status,401);
  assert.equal((await f.request('/account/delete',owner.cookie,{})).status,400);
  assert.equal((await f.request('/account/delete',owner.cookie,{confirm:'yes'})).status,400);
  assert.ok(await f.store.call('attempt',{id:attempt.id}));
  const response=await f.request('/account/delete',owner.cookie,{confirm:'DELETE'});
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie')??'',new RegExp(`${f.auth.cookieName}=;`));
  assert.deepEqual(revoked,[owner.tokenHash]);
  for(const route of ['/attempts',`/attempts/${attempt.id}`,`/attempts/${attempt.id}/reports`])assert.equal((await f.request(route,owner.cookie)).status,401);
  assert.equal((await (await f.request('/auth/session',owner.cookie)).json()).authenticated,false);
  assert.equal(await f.store.call('attempt',{id:attempt.id}),null);
  for(const table of ['players','sessions','attempts','start_receipts','account_starts'])assert.equal(f.count(table),1,table);
  for(const table of ['reports','receipts','phase_jobs'])assert.equal(f.count(table),0,table);
  assert.equal((await (await f.request(`/attempts/${theirs.id}`,other.cookie)).json()).lifecycle,'ACTIVE');
  // Signing in again is a new account with no history, but not a refilled allowance.
  const again=await f.user('owner');assert.notEqual(again.player.id,owner.player.id);
  assert.deepEqual(await (await f.request('/attempts',again.cookie)).json(),{attempts:[],next:null});
  assert.equal((await f.request(`/attempts/${attempt.id}`,again.cookie)).status,404);
  for(const id of ['again-1','again-2']){const next=await f.request('/attempts',again.cookie,f.start(id));assert.equal(next.status,200);await f.request(`/attempts/${(await next.json()).id}/abandon`,again.cookie,{});}
  assert.equal((await (await f.request('/attempts',again.cookie,f.start('again-3'))).json()).code,'DAILY_LIMIT');
  // Deleting twice in a day keeps the higher count; the tombstone goes once the day has passed.
  assert.equal((await f.request('/account/delete',again.cookie,{confirm:'DELETE'})).status,200);
  const third=await f.user('owner');
  assert.equal((await (await f.request('/attempts',third.cookie,f.start('third-1'))).json()).code,'DAILY_LIMIT');
  assert.equal(f.count('deleted_identities'),1);
  f.advance(DAY+3_600_000);
  assert.equal((await f.request('/attempts',third.cookie,await f.today('tomorrow'))).status,200);
  assert.equal(f.count('deleted_identities'),0);
  // A ban outlives its account: a banned identity cannot erase itself.
  await f.service.attempts.banPlayer(other.player.id);
  await assert.rejects(f.store.call('deleteAccount',{playerId:other.player.id,now:f.now()}),{code:'STORE_FORBIDDEN'});
  await assert.rejects(f.store.call('deleteAccount',{playerId:'missing',now:f.now()}),{code:'STORE_FORBIDDEN'});
});

test('deleting an account during an in-flight decision aborts it and nothing is dispatched or committed afterwards',async t=>{
  const f=await setup(t),owner=await f.user('owner'),rules=new PhaseRules(),fallback=offlineDecisions(rules);
  let resolveStarted!:(context:{job:PhaseJob;signal:AbortSignal})=>void,release!:(value:PhaseDecisions)=>void;
  const started=new Promise<{job:PhaseJob;signal:AbortSignal}>(done=>{resolveStarted=done;}),held=new Promise<PhaseDecisions>(done=>{release=done;});
  const attempts=new AttemptService(f.store,{decide:async context=>{resolveStarted(context);return held;},recover:fallback.recover},rules,{now:f.now});
  t.after(()=>attempts.close());
  const attempt=await f.store.call('createAttempt',{id:'in-flight',playerId:owner.player.id,challengeId:'tunis-expedition',challengeVersion:1,reconnectTokenHash:hashToken('t'),now:f.now()});
  const orderIds=(await rules.legal(attempt.board,'TURKEY',new AbortController().signal)).filter(o=>o.order.type==='HOLD').map(o=>o.id);
  await attempts.submit({attemptId:attempt.id,playerId:owner.player.id,revision:0,phaseId:attempt.phaseId,requestId:'orders',action:{phase:'ORDERS',orderIds}});
  const {job,signal}=await started;assert.equal(signal.aborted,false);
  const intent:ProviderCallIntent={id:'late-call',fence:{operationId:job.operationId,attemptId:job.attemptId,phaseId:job.phaseId,revision:job.revision},power:'FRANCE',provider:'OPENAI',model:'gpt-6-luna',role:'ORDERS',pricingVersion:'mock-price-v1',requestHash:hashToken('late'),maxCostNanousd:100000};
  await f.store.call('prepareProviderCall',{intent:{...intent,id:'early-call'},now:f.now()});
  assert.deepEqual(await attempts.deleteAccount(owner.player.id),[owner.tokenHash]);
  assert.equal(signal.aborted,true);
  release(await fallback.decide({job,signal:new AbortController().signal}));
  await attempts.wait(attempt.id);
  assert.equal(await f.store.call('attempt',{id:attempt.id}),null);assert.equal(f.count('reports'),0);assert.equal(f.count('phase_jobs'),0);
  await assert.rejects(f.store.call('prepareProviderCall',{intent,now:f.now()}),{code:'STORE_CONFLICT'});
  await assert.rejects(f.store.call('dispatchProviderCall',{id:'early-call',now:f.now()}),{code:'STORE_CONFLICT'});
  // The record prepared before deletion remains as pseudonymous evidence.
  assert.equal((await f.store.call('providerCall',{id:'early-call'}))!.state,'PREPARED');
});

test('owned history is paginated with a stable cursor and rejects malformed cursors',async t=>{
  const f=await setup(t),owner=await f.user('owner'),other=await f.user('other');
  for(let i=0;i<25;i++){
    const id=`history-${String(i).padStart(2,'0')}`,now=f.now()+Math.floor(i/2)*1000;
    await f.store.call('createAttempt',{id,playerId:owner.player.id,challengeId:'tunis-expedition',challengeVersion:1,reconnectTokenHash:hashToken(id),now});
    await f.store.call('terminateAttempt',{id,playerId:owner.player.id,lifecycle:'ABANDONED',now});
  }
  const first=await (await f.request('/attempts',owner.cookie)).json() as {attempts:ChallengeAttemptView[];next:string|null};
  assert.equal(first.attempts.length,20);assert.equal(first.attempts[0].id,'history-24');assert.ok(first.next);
  const second=await (await f.request(`/attempts?before=${encodeURIComponent(first.next!)}`,owner.cookie)).json() as typeof first;
  assert.equal(second.attempts.length,5);assert.equal(second.next,null);
  assert.equal(new Set([...first.attempts,...second.attempts].map(a=>a.id)).size,25);
  assert.equal((await f.request('/attempts?before=nonsense',owner.cookie)).status,400);
  assert.deepEqual(await (await f.request(`/attempts?before=${encodeURIComponent(first.next!)}`,other.cookie)).json(),{attempts:[],next:null});
});
