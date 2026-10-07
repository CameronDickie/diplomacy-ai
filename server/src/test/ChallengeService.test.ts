import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { Store,newToken } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import type { ChallengeAttemptView,ChallengeLegalCatalog } from '@diplomacy/shared';

async function setup(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-challenge-'));let now=Date.parse('2027-01-01T12:00:00Z');
  const path=join(dir,'game.sqlite'),store=await Store.open(path);
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4)};
  const config=readRuntimeConfig(env),auth=new AuthService(store,config,env,undefined,()=>now);
  const service=await ChallengeService.open(store,config,()=>now);
  const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api/auth',auth.router());app.use('/api',service.router(auth));
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const request=(route:string,cookie='',body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function user(subject:string){
    const player=await store.call('identity',{provider:'github',subject,displayName:'Private display name',now});
    const cookie=`${auth.cookieName}=${newToken()}`;
    await store.call('createSession',{tokenHash:auth.tokenHash(cookie)!,playerId:player.id,now,expiresAt:now+7*86400000});return {player,cookie};
  }
  const start={requestId:'start-1',challengeId:'tunis-expedition',challengeVersion:1};
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  return {store,service,request,user,start,path,config,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}

test('public introduction/demo expose no player internals; start and owned catalogs require the owner',async t=>{
  const f=await setup(t),owner=await f.user('owner'),other=await f.user('other');
  const catalog=await f.request('/challenges');assert.equal(catalog.status,200);assert.equal((await catalog.json()).challenges[0].mode,'PRACTICE');
  const demo=await (await f.request('/challenges/demo')).json();assert.equal(demo.reports.length,4);assert.ok(!JSON.stringify(demo).includes('playerId'));
  assert.equal((await f.request('/attempts','',f.start)).status,401);
  assert.equal((await f.request('/attempts',owner.cookie,{...f.start,model:'override'})).status,400);
  const started=await f.request('/attempts',owner.cookie,f.start);assert.equal(started.status,200);
  const attempt=await started.json() as ChallengeAttemptView;
  const text=JSON.stringify(attempt);for(const secret of ['playerId','reconnect','Private display name','tokenHash','decisions'])assert.ok(!text.includes(secret));
  assert.equal((await f.request(`/attempts/${attempt.id}`,other.cookie)).status,404);
  assert.equal((await f.request(`/attempts/${attempt.id}/legal`,other.cookie)).status,404);
  assert.equal((await f.request(`/attempts/${attempt.id}/orders`,other.cookie,{revision:0,phaseId:attempt.phaseId,requestId:'theft',action:{phase:'ORDERS',orderIds:[]}})).status,404);
  const legal=await (await f.request(`/attempts/${attempt.id}/legal`,owner.cookie)).json() as ChallengeLegalCatalog;
  assert.ok(legal.options.length>0);assert.ok(legal.options.every(o=>o.order.power==='TURKEY'));
  assert.equal(legal.phaseId,attempt.phaseId);assert.equal(legal.revision,0);
});

test('start admission is atomic, idempotent, quota limited and remains bounded across store reopen',async t=>{
  const f=await setup(t),users=await Promise.all(['1','2','3','4','5'].map(f.user));
  const copies=await Promise.all([f.request('/attempts',users[0].cookie,f.start),f.request('/attempts',users[0].cookie,f.start)]);
  const a=await copies[0].json(),b=await copies[1].json();assert.equal(a.id,b.id);
  const rest=await Promise.all(users.slice(1).map(u=>f.request('/attempts',u.cookie,f.start)));
  assert.equal(rest.filter(r=>r.status===200).length,2);assert.equal(rest.filter(r=>r.status===409).length,2);
  assert.equal((await f.store.call('activeAttempts',{})).length,3);
  assert.equal((await (await f.request('/attempts',users[0].cookie,{...f.start,requestId:'second'})).json()).code,'ACTIVE_ATTEMPT_EXISTS');
  await f.request(`/attempts/${a.id}/abandon`,users[0].cookie,{});
  for(const id of ['second','third']){
    const response=await f.request('/attempts',users[0].cookie,{...f.start,requestId:id});assert.equal(response.status,200);
    await f.request(`/attempts/${(await response.json()).id}/abandon`,users[0].cookie,{});
  }
  assert.equal((await (await f.request('/attempts',users[0].cookie,{...f.start,requestId:'fourth'})).json()).code,'DAILY_LIMIT');
  const another=await Store.open(f.path);
  try{await assert.rejects(another.call('admitAttempt',{id:'fresh',playerId:users[0].player.id,requestId:'after-reopen',challengeId:f.start.challengeId,challengeVersion:1,now:f.now(),maxActive:3,maxPerAccount:1,dailyLimit:3}),{code:'DAILY_LIMIT'});}
  finally{await another.close();}
  const duplicate=await (await f.request('/attempts',users[0].cookie,f.start)).json();assert.equal(duplicate.id,a.id);assert.equal(duplicate.lifecycle,'ABANDONED');
  f.advance(86400000);assert.equal((await f.request('/attempts',users[0].cookie,{...f.start,requestId:'tomorrow'})).status,200);
});

test('owned orders advance, reject a stale catalog and replay the durable receipt after service restart',async t=>{
  const f=await setup(t),owner=await f.user('owner');
  const attempt=await (await f.request('/attempts',owner.cookie,f.start)).json() as ChallengeAttemptView;
  const legal=await (await f.request(`/attempts/${attempt.id}/legal`,owner.cookie)).json() as ChallengeLegalCatalog;
  const command={revision:attempt.revision,phaseId:attempt.phaseId,requestId:'orders-1',action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}};
  assert.equal((await f.request(`/attempts/${attempt.id}/orders`,owner.cookie,command)).status,200);
  await f.service.attempts.wait(attempt.id);
  const next=await (await f.request(`/attempts/${attempt.id}`,owner.cookie)).json() as ChallengeAttemptView;
  assert.equal(next.board.season,'FALL');assert.equal(next.execution,'ACCEPTING');
  assert.equal((await f.request(`/attempts/${attempt.id}/orders`,owner.cookie,{...command,requestId:'stale'})).status,409);
  assert.equal((await (await f.request(`/attempts/${attempt.id}/orders`,owner.cookie,command)).json()).status,'ACCEPTED');
  await f.service.close();
  const reopened=await ChallengeService.open(f.store,f.config,f.now);
  try{assert.equal((await f.store.call('attempt',{id:attempt.id}))!.phaseId,next.phaseId);assert.equal((await f.store.call('reports',{attemptId:attempt.id})).length,1);}
  finally{await reopened.close();}
});

test('polling does not extend idle time; activity renews it and expiry closes the attempt before new orders',async t=>{
  const f=await setup(t),owner=await f.user('owner');
  const attempt=await (await f.request('/attempts',owner.cookie,f.start)).json() as ChallengeAttemptView;
  f.advance(26*60000);
  const warning=await (await f.request(`/attempts/${attempt.id}`,owner.cookie)).json() as ChallengeAttemptView;
  assert.equal(warning.lastActivityAt,attempt.lastActivityAt);assert.ok(warning.idleWarnAt<f.now());
  const active=await (await f.request(`/attempts/${attempt.id}/activity`,owner.cookie,{revision:attempt.revision})).json() as ChallengeAttemptView;
  assert.equal(active.lastActivityAt,f.now());
  // A sweep selected before that meaningful activity must not expire the renewed attempt.
  const preserved=await f.service.attempts.terminate(attempt.id,owner.player.id,'EXPIRED',attempt.lastActivityAt);
  assert.equal(preserved.lifecycle,'ACTIVE');
  f.advance(30*60000);
  const expired=await (await f.request(`/attempts/${attempt.id}`,owner.cookie)).json() as ChallengeAttemptView;
  assert.equal(expired.lifecycle,'EXPIRED');
  assert.equal((await f.request(`/attempts/${attempt.id}/activity`,owner.cookie,{revision:expired.revision})).status,409);
  assert.equal((await f.request(`/attempts/${attempt.id}/orders`,owner.cookie,{revision:expired.revision,phaseId:expired.phaseId,requestId:'too-late',action:{phase:'ORDERS',orderIds:[]}})).status,409);
});
