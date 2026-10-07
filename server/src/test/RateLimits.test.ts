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
import { OperatorService } from '../operator/OperatorService.js';
import { localDelivery } from '../operator/Notifier.js';
import { RateLimiter,RATE_POLICY,clientAddress,isPrivateAddress } from '../limits/RateLimiter.js';
import type { ChallengeAttemptView,ChallengeLegalCatalog } from '@diplomacy/shared';

async function setup(t:test.TestContext,extra:Record<string,string>={}){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-limits-'));let now=Date.parse('2027-01-01T23:58:30Z');
  const store=await Store.open(join(dir,'game.sqlite'));
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4),DIPLOMACY_ADMIN_GITHUB_USER_IDS:'4242',...extra};
  const config=readRuntimeConfig(env),auth=new AuthService(store,config,env,undefined,()=>now);
  const service=await ChallengeService.open(store,config,()=>now),operator=new OperatorService(store,config,service.attempts,()=>now,localDelivery);
  const app=express();app.use(express.json({limit:'64kb'}));app.use('/api',auth.httpBoundary);app.use('/api/operator',operator.router(auth));app.use('/api',service.router(auth));
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const request=(route:string,cookie='',body?:unknown,headers:Record<string,string>={})=>fetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  async function user(subject:string){
    const player=await store.call('identity',{provider:'github',subject,displayName:'Test',now});
    const session=async()=>{const cookie=`${auth.cookieName}=${newToken()}`;await store.call('createSession',{tokenHash:auth.tokenHash(cookie)!,playerId:player.id,now,expiresAt:now+86_400_000});return cookie;};
    return {player,cookie:await session(),session};
  }
  const start=(requestId:string)=>({requestId,challengeId:'tunis-expedition',challengeVersion:1});
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await operator.close();await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  return {store,service,request,user,start,config,now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
const limited=async(response:Response)=>{
  assert.equal(response.status,429);const body=await response.json();
  assert.equal(body.code,'RATE_LIMITED');assert.equal(response.headers.get('retry-after'),String(body.retryAfterSeconds));assert.ok(body.retryAfterSeconds>=1&&body.retryAfterSeconds<=60);
  return body.retryAfterSeconds as number;
};

test('fixed windows allow the limit, report the wait, reset on time and stay bounded under a key flood',()=>{
  let now=1_000_000;const limiter=new RateLimiter('none',()=>now,3),rule={limit:2,windowMs:60_000};
  assert.deepEqual([limiter.take('a',rule),limiter.take('a',rule),limiter.take('a',rule)],[0,0,60]);
  now+=59_001;assert.equal(limiter.take('a',rule),1);
  now+=999;assert.equal(limiter.take('a',rule),0);
  // Three live keys fill the table: a fourth is refused rather than growing memory, then admitted once others expire.
  assert.equal(limiter.take('b',rule),0);assert.equal(limiter.take('c',rule),0);assert.equal(limiter.take('d',rule),60);
  now+=60_000;assert.equal(limiter.take('d',rule),0);
});

test('forwarded addresses are ignored unless a private proxy is trusted, and then only its own entry counts',()=>{
  const request=(remoteAddress:string,forwarded?:string|string[])=>({socket:{remoteAddress},headers:forwarded===undefined?{}:{'x-forwarded-for':forwarded}});
  for(const ip of ['10.1.2.3','172.16.0.9','172.31.255.1','192.168.1.1','127.0.0.1','::1','fd00::1','::ffff:10.0.0.4'])assert.ok(isPrivateAddress(ip),ip);
  for(const ip of ['8.8.8.8','172.32.0.1','172.15.0.1','192.169.0.1','2001:db8::1','not-an-ip',''])assert.ok(!isPrivateAddress(ip),ip);
  assert.equal(clientAddress(request('172.18.0.3','203.0.113.9'),'none'),'172.18.0.3');
  // A public peer claiming a forwarded address is the classic spoof.
  assert.equal(clientAddress(request('198.51.100.7','10.0.0.1'),'private'),'198.51.100.7');
  assert.equal(clientAddress(request('172.18.0.3','203.0.113.9'),'private'),'203.0.113.9');
  assert.equal(clientAddress(request('172.18.0.3','1.1.1.1, 2.2.2.2, 203.0.113.9'),'private'),'203.0.113.9');
  assert.equal(clientAddress(request('172.18.0.3',['1.1.1.1','203.0.113.9']),'private'),'203.0.113.9');
  for(const junk of ['','garbage','203.0.113.9, <script>','9'.repeat(200)])assert.equal(clientAddress(request('172.18.0.3',junk),'private'),'172.18.0.3');
  assert.equal(clientAddress({socket:{},headers:{}},'private'),'unknown');
});

test('start bursts get a typed retry, cannot be evaded with a new session or forged header, and never touch the quota',async t=>{
  const f=await setup(t),a=await f.user('a'),b=await f.user('b');
  const first=await (await f.request('/attempts',a.cookie,f.start('start-1'))).json() as ChallengeAttemptView;
  // Idempotent retries stay usable up to the limit and return the same attempt.
  for(let i=1;i<RATE_POLICY.start.identity.limit;i++)assert.equal((await (await f.request('/attempts',a.cookie,f.start('start-1'))).json()).id,first.id);
  const wait=await limited(await f.request('/attempts',a.cookie,f.start('start-1')));
  await limited(await f.request('/attempts',await a.session(),f.start('start-1')));
  await limited(await f.request('/attempts',a.cookie,f.start('start-1'),{'X-Forwarded-For':'203.0.113.50'}));
  assert.equal((await f.store.call('activeAttempts',{})).length,1);
  // Another account is unaffected, and reading the attempt is a different bucket.
  assert.equal((await f.request('/attempts',b.cookie,f.start('b-1'))).status,200);
  assert.equal((await f.request(`/attempts/${first.id}`,a.cookie)).status,200);
  f.advance(wait*1000);
  assert.equal((await (await f.request('/attempts',a.cookie,f.start('start-1'))).json()).id,first.id);
  // The burst consumed one accepted start, not ten: two more are still available today.
  await f.request(`/attempts/${first.id}/abandon`,a.cookie,{});
  for(const id of ['start-2','start-3']){const next=await f.request('/attempts',a.cookie,f.start(id));assert.equal(next.status,200);await f.request(`/attempts/${(await next.json()).id}/abandon`,a.cookie,{});}
  assert.equal((await (await f.request('/attempts',a.cookie,f.start('start-4'))).json()).code,'DAILY_LIMIT');
  // Exact UTC rollover: one millisecond before midnight is still today.
  f.advance(Date.parse('2027-01-01T23:59:59.999Z')-f.now());
  assert.equal((await (await f.request('/attempts',a.cookie,f.start('start-5'))).json()).code,'DAILY_LIMIT');
  f.advance(1);
  assert.equal((await f.request('/attempts',a.cookie,f.start('start-6'))).status,200);
});

test('command and legal-catalog bursts are limited per account while a duplicate order retry returns its receipt',async t=>{
  const f=await setup(t),a=await f.user('a');
  const attempt=await (await f.request('/attempts',a.cookie,f.start('start-1'))).json() as ChallengeAttemptView;
  const legal=await (await f.request(`/attempts/${attempt.id}/legal`,a.cookie)).json() as ChallengeLegalCatalog;
  const command={revision:attempt.revision,phaseId:attempt.phaseId,requestId:'orders-1',action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}};
  assert.equal((await f.request(`/attempts/${attempt.id}/orders`,a.cookie,command)).status,200);
  await f.service.attempts.wait(attempt.id);
  // A reconnecting client repeating its accepted command gets the same receipt and creates no second phase.
  for(let i=0;i<5;i++)assert.equal((await (await f.request(`/attempts/${attempt.id}/orders`,a.cookie,command)).json()).status,'ACCEPTED');
  assert.equal((await f.store.call('reports',{attemptId:attempt.id})).length,1);
  const current=await (await f.request(`/attempts/${attempt.id}`,a.cookie)).json() as ChallengeAttemptView;
  let refused=0;
  for(let i=0;i<RATE_POLICY.command.identity.limit;i++){const r=await f.request(`/attempts/${attempt.id}/activity`,a.cookie,{revision:current.revision});if(r.status===429)refused++;else assert.equal(r.status,200);}
  assert.equal(refused,6);
  await limited(await f.request(`/attempts/${attempt.id}/orders`,a.cookie,{...command,requestId:'burst'}));
  await limited(await f.request(`/attempts/${attempt.id}/abandon`,a.cookie,{}));
  assert.equal((await f.store.call('attempt',{id:attempt.id}))!.lifecycle,'ACTIVE');
  for(let i=1;i<RATE_POLICY.legal.identity.limit;i++)assert.equal((await f.request(`/attempts/${attempt.id}/legal`,a.cookie)).status,200);
  await limited(await f.request(`/attempts/${attempt.id}/legal`,a.cookie));
  // Polling the attempt is still allowed, so a limited client can recover without reloading.
  assert.equal((await f.request(`/attempts/${attempt.id}`,a.cookie)).status,200);
  f.advance(60_000);
  assert.equal((await f.request(`/attempts/${attempt.id}/abandon`,a.cookie,{})).status,200);
});

test('unauthenticated floods, public reads and oversized or malformed bodies are bounded before any work',async t=>{
  const f=await setup(t),a=await f.user('a');
  let ok=0,refused=0;
  for(let i=0;i<RATE_POLICY.start.address.limit+5;i++){const r=await f.request('/attempts','',f.start(`anon-${i}`));if(r.status===401)ok++;else{await limited(r);refused++;}}
  assert.deepEqual([ok,refused],[RATE_POLICY.start.address.limit,5]);
  // The address bucket is supplementary: it also stops a signed-in caller from that address for this category only.
  await limited(await f.request('/attempts',a.cookie,f.start('start-1')));
  assert.equal((await f.request('/challenges')).status,200);
  f.advance(60_000);
  assert.equal((await f.request('/attempts',a.cookie,{...f.start('big'),padding:'x'.repeat(70_000)})).status,413);
  assert.equal((await f.request('/attempts',a.cookie,'{"requestId":')).status,400);
  assert.equal((await f.store.call('activeAttempts',{})).length,0);
  for(let i=0;i<RATE_POLICY.public.address.limit;i++)assert.equal((await f.request(i%2?'/challenges':'/challenges/demo')).status,200);
  await limited(await f.request('/challenges'));await limited(await f.request('/challenges/demo'));
});

test('behind a trusted private proxy each forwarded client has its own bucket and cannot borrow another by appending',async t=>{
  const f=await setup(t,{DIPLOMACY_TRUSTED_PROXY:'private'});
  const from=(chain:string)=>f.request('/attempts','',f.start('x'),{'X-Forwarded-For':chain});
  for(let i=0;i<RATE_POLICY.start.address.limit;i++)assert.equal((await from('203.0.113.1')).status,401);
  await limited(await from('203.0.113.1'));
  // Prepending forged hops does not change the entry the proxy itself appended.
  await limited(await from('9.9.9.9, 8.8.8.8, 203.0.113.1'));
  assert.equal((await from('203.0.113.2')).status,401);
});

test('operator routes are rate limited per operator without affecting player routes',async t=>{
  const f=await setup(t),owner=await f.user('4242');
  for(let i=0;i<RATE_POLICY.operator.identity.limit;i++)assert.equal((await f.request('/operator/overview',owner.cookie)).status,200);
  await limited(await f.request('/operator/overview',owner.cookie));
  await limited(await f.request('/operator/paid',owner.cookie,{stopped:true}));
  assert.equal((await f.store.call('paidState',{})).stopped,false);
  assert.equal((await f.request('/attempts',owner.cookie)).status,200);
});
