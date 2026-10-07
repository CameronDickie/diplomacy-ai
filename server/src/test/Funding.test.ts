import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store,hashToken } from '../storage/Store.js';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { challengeDefinition } from '../fixtures/ScenarioFixture.js';
import type { ProviderCallIntent,ProviderUsage } from '../providers/accounting.js';

const DAY=86_400_000,COST=100_000;
const usage=(costNanousd:number):ProviderUsage=>({inputTokens:100,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:50,reasoningTokens:0,costNanousd});
async function setup(t:test.TestContext,granted:number|null=1_000_000){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-funding-')),path=join(dir,'game.sqlite');let now=1_800_000_000_000;
  let store=await Store.open(path);
  const fixture=JSON.parse(await readFile(new URL('../../fixtures/development/tunis-expedition.v1.json',import.meta.url),'utf8'));
  const content={definition:challengeDefinition(fixture)!,board:fixture.board};
  await store.call('registerChallenge',{...content,hash:createHash('sha256').update(canonicalJson(content)).digest('hex'),now});
  if(granted!==null)await store.call('grantFunding',{amountNanousd:granted,authorizationRef:'test-grant-0001',grantedBy:'test',now});
  let players=0;
  /** A fresh account with one active attempt whose phase is waiting on opponent decisions. */
  async function phase(id:string){
    const player=await store.call('identity',{provider:'github',subject:`funding-${++players}`,displayName:'Test',now});
    const attempt=await store.call('createAttempt',{id,playerId:player.id,challengeId:'tunis-expedition',challengeVersion:1,reconnectTokenHash:hashToken(id),now});
    const {job}=await store.call('beginPhase',{id,playerId:player.id,expectedRevision:0,phaseId:attempt.phaseId,operationId:`${id}-phase`,requestId:'orders',action:{phase:'ORDERS',orderIds:['CON|HOLD','SMY|HOLD','ANK|HOLD']},now});
    const fence={operationId:job.operationId,attemptId:job.attemptId,phaseId:job.phaseId,revision:job.revision};
    const intent=(call:string,maxCostNanousd=COST):ProviderCallIntent=>({id:call,fence,power:'FRANCE',provider:'OPENAI',model:'gpt-6-luna',role:'ORDERS',pricingVersion:'mock-price-v1',requestHash:hashToken(call),maxCostNanousd});
    return {player,attempt,job,fence,intent,prepare:(call:string,max=COST)=>store.call('prepareProviderCall',{intent:intent(call,max),now}),
      async bill(call:string,cost:number){await store.call('dispatchProviderCall',{id:call,now});return store.call('receiveProviderCall',{id:call,responseId:`resp_${call}`,usage:usage(cost),now});}};
  }
  const sql=<T>(work:(db:DatabaseSync)=>T)=>{const db=new DatabaseSync(path);try{return work(db);}finally{db.close();}};
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,path,phase,sql,get store(){return store;},now:()=>now,advance:(ms:number)=>{now+=ms;},totals:()=>store.call('fundingTotals',{}),
    async reopen(){await store.close();store=await Store.open(path);}};
}

test('a database with no grant admits no paid call, records the stop and leaves no call or reservation behind',async t=>{
  const f=await setup(t,null),p=await f.phase('a');
  assert.deepEqual(await f.totals(),{grantedNanousd:0,ceilingNanousd:0,settledNanousd:0,reservedNanousd:0,unknownLiabilityNanousd:0,availableNanousd:0,attemptCapNanousd:1_000_000_000,grants:0});
  await assert.rejects(p.prepare('first'),{code:'BUDGET_EXHAUSTED'});
  assert.equal(await f.store.call('providerCall',{id:'first'}),null);
  assert.equal(f.sql(db=>Number(db.prepare('SELECT count(*) n FROM reservations').get()!.n)),0);
  // The stop is durable even though the refused call was not: exhaustion pauses paid play.
  assert.deepEqual({...await f.store.call('paidState',{}),updatedAt:0},{stopped:true,episode:1,updatedAt:0});
  await f.reopen();
  assert.equal((await f.store.call('paidState',{})).stopped,true);
  assert.deepEqual((await f.store.call('operatorOverview',{})).audit.map(a=>[a.action,a.operatorId]),[['BUDGET_EXHAUSTED','system']]);
});

test('grants are explicit, idempotent by reference, immutable and the only source of funds',async t=>{
  const f=await setup(t,null);
  const grant=(amountNanousd:number,authorizationRef:string)=>f.store.call('grantFunding',{amountNanousd,authorizationRef,grantedBy:'test',now:f.now()});
  assert.equal((await grant(500,'owner-ref-0001')).ceilingNanousd,500);
  assert.equal((await grant(500,'owner-ref-0001')).ceilingNanousd,500);
  await assert.rejects(grant(900,'owner-ref-0001'),{code:'STORE_CONFLICT'});
  assert.deepEqual([(await grant(250,'owner-ref-0002')).ceilingNanousd,(await f.totals()).grants],[750,2]);
  for(const [amount,ref] of [[0,'owner-ref-0003'],[-5,'owner-ref-0003'],[1.5,'owner-ref-0003'],[Number.NaN,'owner-ref-0003'],[2e15,'owner-ref-0003'],[100,'short'],[100,'has spaces in it']] as const)
    await assert.rejects(grant(amount,ref),{code:'STORE_INVALID'},`${amount} ${ref}`);
  f.sql(db=>{
    assert.throws(()=>db.exec("UPDATE funding_grants SET amount_nanousd=999999999"),/immutable funding grant/);
    assert.throws(()=>db.exec("DELETE FROM funding_grants"),/funding grants are permanent/);
    assert.throws(()=>db.exec("DELETE FROM funding_pool"),/funding pool is permanent/);
    assert.throws(()=>db.exec("INSERT INTO funding_pool(id,attempt_cap_nanousd,updated_at) VALUES(2,1,0)"));
  });
  await f.reopen();
  assert.equal((await f.totals()).ceilingNanousd,750);
  // Policy narrows; it cannot add. The attempt cap is bounded by the fifteen-dollar policy ceiling.
  const policy=(attemptCapNanousd:number,ceilingLimitNanousd:number|null)=>f.store.call('setFundingPolicy',{attemptCapNanousd,ceilingLimitNanousd,now:f.now()});
  assert.equal((await policy(1000,400)).ceilingNanousd,400);
  assert.equal((await policy(1000,1_000_000)).ceilingNanousd,750);
  assert.equal((await policy(15_000_000_000,null)).attemptCapNanousd,15_000_000_000);
  for(const [cap,limit] of [[15_000_000_001,null],[0,null],[1000,-1],[1.5,null]] as const)await assert.rejects(policy(cap,limit),{code:'STORE_INVALID'});
});

test('a call reserves its worst case, settles its real cost exactly once and never frees money on a duplicate',async t=>{
  const f=await setup(t),p=await f.phase('a');
  await p.prepare('one');
  assert.deepEqual([(await f.totals()).reservedNanousd,(await f.totals()).availableNanousd],[COST,900_000]);
  // Preparing the same call again is the same reservation, not a second one.
  await p.prepare('one');assert.equal((await f.totals()).reservedNanousd,COST);
  await f.store.call('dispatchProviderCall',{id:'one',now:f.now()});
  const receipt={id:'one',responseId:'resp_one',usage:usage(12_345),now:f.now()};
  await Promise.all([f.store.call('receiveProviderCall',receipt),f.store.call('receiveProviderCall',receipt)]);
  await f.store.call('receiveProviderCall',receipt);
  assert.deepEqual(await f.totals(),{grantedNanousd:1_000_000,ceilingNanousd:1_000_000,settledNanousd:12_345,reservedNanousd:0,unknownLiabilityNanousd:0,availableNanousd:987_655,attemptCapNanousd:1_000_000_000,grants:1});
  assert.deepEqual(await f.store.call('attemptFunding',{attemptId:'a'}),{settledNanousd:12_345,heldNanousd:0});
  await assert.rejects(f.store.call('receiveProviderCall',{...receipt,usage:usage(1)}),{code:'STORE_CONFLICT'});
  assert.equal((await f.totals()).settledNanousd,12_345);
  f.sql(db=>{
    assert.throws(()=>db.exec("UPDATE reservations SET state='HELD',settled_nanousd=NULL"),/closed reservation is final/);
    assert.throws(()=>db.exec("UPDATE funding_pool SET settled_nanousd=0"),/never decreases/);
  });
});

test('uncertain outcomes keep their reservation through timeout, abandon, ban, deletion and restart; a late bill settles it',async t=>{
  const f=await setup(t),timeout=await f.phase('timeout'),noUsage=await f.phase('no-usage'),banned=await f.phase('banned'),deleted=await f.phase('deleted');
  for(const [p,call] of [[timeout,'t1'],[noUsage,'n1'],[banned,'b1'],[deleted,'d1']] as const){await p.prepare(call);await f.store.call('dispatchProviderCall',{id:call,now:f.now()});}
  await f.store.call('finishProviderCall',{id:'t1',outcome:'TIMEOUT',now:f.now()});
  await f.store.call('receiveProviderCall',{id:'n1',responseId:'resp_n1',usage:null,now:f.now()});
  await f.store.call('terminateAttempt',{id:'timeout',playerId:timeout.player.id,lifecycle:'ABANDONED',now:f.now()});
  await f.store.call('banPlayer',{playerId:banned.player.id,banned:true,now:f.now()});
  await f.store.call('deleteAccount',{playerId:deleted.player.id,now:f.now()});
  const held=async()=>{const x=await f.totals();return [x.settledNanousd,x.reservedNanousd,x.unknownLiabilityNanousd,x.availableNanousd];};
  // b1 and d1 are still in flight; t1 finished without usage and n1 answered without usage.
  assert.deepEqual(await held(),[0,2*COST,2*COST,600_000]);
  await f.reopen();f.advance(400*DAY);
  assert.deepEqual(await f.store.call('reconcileFunding',{now:f.now()}),{released:0});
  await f.store.call('sweepRetention',{now:f.now(),resultBefore:f.now()-30*DAY,diagnosticBefore:f.now()-7*DAY,receiptBefore:f.now()-90*DAY,limit:200});
  assert.deepEqual(await held(),[0,2*COST,2*COST,600_000]);
  for(const call of ['t1','n1','b1','d1'])assert.ok(await f.store.call('providerCall',{id:call}),call);
  // The bill for the deleted account's call arrives late and is charged in full.
  await f.store.call('receiveProviderCall',{id:'d1',responseId:'resp_d1',usage:usage(40_000),now:f.now()});
  await f.store.call('receiveProviderCall',{id:'t1',responseId:'resp_t1',usage:usage(60_000),now:f.now()});
  assert.deepEqual(await held(),[100_000,COST,COST,700_000]);
});

test('only a call that was never dispatched can be released, explicitly or by reconciliation after its attempt closes',async t=>{
  const f=await setup(t),live=await f.phase('live'),closed=await f.phase('closed');
  await live.prepare('live-prepared');await live.prepare('live-sent');await f.store.call('dispatchProviderCall',{id:'live-sent',now:f.now()});
  await closed.prepare('closed-prepared');await closed.prepare('closed-sent');await f.store.call('dispatchProviderCall',{id:'closed-sent',now:f.now()});
  assert.equal((await f.totals()).reservedNanousd,4*COST);
  await assert.rejects(f.store.call('releaseProviderCall',{id:'live-sent',now:f.now()}),{code:'STORE_CONFLICT'});
  await assert.rejects(f.store.call('releaseProviderCall',{id:'missing',now:f.now()}),{code:'STORE_CONFLICT'});
  // While the attempt is live, reconciliation leaves even its undispatched call alone.
  assert.deepEqual(await f.store.call('reconcileFunding',{now:f.now()}),{released:0});
  await f.store.call('terminateAttempt',{id:'closed',playerId:closed.player.id,lifecycle:'EXPIRED',now:f.now()});
  assert.deepEqual(await f.store.call('reconcileFunding',{now:f.now()}),{released:1});
  assert.deepEqual(await f.store.call('reconcileFunding',{now:f.now()}),{released:0});
  const released=await f.store.call('providerCall',{id:'closed-prepared'});
  assert.deepEqual([released!.state,released!.outcome,released!.dispatchedAt],['FINISHED','CANCELLED',null]);
  assert.equal((await f.store.call('providerCall',{id:'closed-sent'}))!.state,'DISPATCHED');
  assert.equal((await f.store.call('releaseProviderCall',{id:'live-prepared',now:f.now()})).reservedNanousd,2*COST);
  // A released call can never be dispatched afterwards, so releasing it could not hide a charge.
  await assert.rejects(f.store.call('dispatchProviderCall',{id:'live-prepared',now:f.now()}),{code:'STORE_CONFLICT'});
  await assert.rejects(f.store.call('receiveProviderCall',{id:'live-prepared',responseId:'resp_x',usage:usage(1),now:f.now()}),{code:'STORE_CONFLICT'});
  assert.equal((await f.totals()).availableNanousd,1_000_000-2*COST);
});

test('the attempt cap stops one attempt without pausing the site; a new account or attempt cannot evade the pool',async t=>{
  const f=await setup(t,450_000),a=await f.phase('a');
  await f.store.call('setFundingPolicy',{attemptCapNanousd:250_000,ceilingLimitNanousd:null,now:f.now()});
  await a.prepare('a1');await a.bill('a1',90_000);await a.prepare('a2');
  // 90,000 settled + 100,000 held + another 100,000 would pass the 250,000 cap.
  await assert.rejects(a.prepare('a3'),{code:'ATTEMPT_BUDGET_EXHAUSTED'});
  assert.equal((await f.store.call('paidState',{})).stopped,false);
  assert.equal(await f.store.call('providerCall',{id:'a3'}),null);
  assert.equal((await a.prepare('a3-small',60_000)).state,'PREPARED');
  // Other accounts draw on the same pool: 450,000 − 90,000 − 160,000 = 200,000 left.
  const b=await f.phase('b'),c=await f.phase('c');
  await b.prepare('b1');await b.prepare('b2');
  assert.equal((await f.totals()).availableNanousd,0);
  await assert.rejects(c.prepare('c1'),{code:'BUDGET_EXHAUSTED'});
  assert.equal((await f.store.call('paidState',{})).stopped,true);
  // Stopped is stopped for everyone, including calls already prepared.
  await assert.rejects(f.store.call('dispatchProviderCall',{id:'b1',now:f.now()}),{code:'STORE_CONFLICT'});
  // Resuming without new funds cannot admit anything; a grant plus resume can.
  await f.store.call('setPaidStopped',{stopped:false,operatorId:'owner',now:f.now()});
  await assert.rejects(c.prepare('c1'),{code:'BUDGET_EXHAUSTED'});
  assert.deepEqual({...await f.store.call('paidState',{}),updatedAt:0},{stopped:true,episode:2,updatedAt:0});
  await f.store.call('grantFunding',{amountNanousd:100_000,authorizationRef:'owner-ref-0002',grantedBy:'test',now:f.now()});
  await assert.rejects(c.prepare('c1'),{code:'STORE_CONFLICT'});
  await f.store.call('setPaidStopped',{stopped:false,operatorId:'owner',now:f.now()});
  assert.equal((await c.prepare('c1')).state,'PREPARED');
  assert.deepEqual((await f.store.call('operatorOverview',{})).audit.map(x=>x.action),['PAID_RESUME','BUDGET_EXHAUSTED','PAID_RESUME','BUDGET_EXHAUSTED']);
});

test('a bill above its reservation is kept in full and pauses paid play',async t=>{
  const f=await setup(t,300_000),p=await f.phase('a');
  await p.prepare('over');await p.bill('over',250_000);
  assert.deepEqual([(await f.totals()).settledNanousd,(await f.totals()).availableNanousd],[250_000,50_000]);
  assert.equal((await f.store.call('paidState',{})).stopped,true);
  assert.deepEqual((await f.store.call('operatorOverview',{})).audit.map(x=>x.action),['COST_ANOMALY']);
  await assert.rejects(p.prepare('next'),{code:'STORE_CONFLICT'});
});

test('concurrent reservations across separate connections never exceed the pool or the attempt cap',async t=>{
  const f=await setup(t,550_000),a=await f.phase('a'),b=await f.phase('b'),others=await Promise.all([Store.open(f.path),Store.open(f.path)]);
  t.after(()=>Promise.all(others.map(s=>s.close())));
  await f.store.call('setFundingPolicy',{attemptCapNanousd:400_000,ceilingLimitNanousd:null,now:f.now()});
  const stores=[f.store,...others];
  const results=await Promise.allSettled(Array.from({length:24},(_,i)=>{
    const p=i%2?a:b;
    const attempt=async(tries=0):Promise<unknown>=>{
      try{return await stores[i%3].call('prepareProviderCall',{intent:p.intent(`race-${i}`),now:f.now()});}
      catch(error){if((error as {code?:string}).code==='STORE_BUSY'&&tries<50){await new Promise(done=>setTimeout(done,5));return attempt(tries+1);}throw error;}
    };
    return attempt();
  }));
  const refused=results.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason.code as string);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,5);
  assert.ok(refused.every(code=>['BUDGET_EXHAUSTED','ATTEMPT_BUDGET_EXHAUSTED','STORE_CONFLICT'].includes(code)),refused.join());
  const totals=await f.totals();
  assert.deepEqual([totals.reservedNanousd,totals.availableNanousd],[500_000,50_000]);
  for(const id of ['a','b'])assert.ok((await f.store.call('attemptFunding',{attemptId:id})).heldNanousd<=400_000);
  assert.equal(f.sql(db=>Number(db.prepare('SELECT count(*) n FROM provider_calls').get()!.n)),5);
});

test('a process killed between ledger steps never loses a reservation and never settles twice',async t=>{
  for(const stage of ['BEFORE_RESERVE','RESERVED','DISPATCHED','SETTLED'] as const){
    const f=await setup(t),p=await f.phase('a');
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/crashFunding.js',import.meta.url)),f.path,stage,JSON.stringify(p.fence)],{stdio:'ignore',env:{PATH:process.env.PATH}});
    const [code,signal]=await once(child,'exit');assert.equal(code,null,stage);assert.equal(signal,'SIGKILL',stage);
    await f.reopen();
    const totals=await f.totals(),view=[totals.settledNanousd,totals.reservedNanousd,totals.availableNanousd];
    if(stage==='BEFORE_RESERVE')assert.deepEqual(view,[0,0,1_000_000],stage);
    else if(stage==='SETTLED')assert.deepEqual(view,[12_345,0,987_655],stage);
    else assert.deepEqual(view,[0,COST,900_000],stage);
    if(stage==='DISPATCHED'||stage==='SETTLED'){
      // Recovery re-delivers the same bill: it is charged once in total.
      await f.store.call('receiveProviderCall',{id:'crash',responseId:'resp_crash',usage:usage(12_345),now:f.now()});
      assert.deepEqual([(await f.totals()).settledNanousd,(await f.totals()).reservedNanousd],[12_345,0],stage);
      await assert.rejects(f.store.call('dispatchProviderCall',{id:'crash',now:f.now()}),{code:'STORE_CONFLICT'});
    }
    if(stage==='RESERVED'){
      // The same call may still be dispatched once, under its existing reservation.
      assert.equal((await p.prepare('crash')).state,'PREPARED');
      assert.equal((await f.totals()).reservedNanousd,COST);
    }
  }
});

test('receipt cleanup, backup and restore never change settled spend, held liability or available funds',async t=>{
  const f=await setup(t),p=await f.phase('a'),q=await f.phase('b');
  await p.prepare('old-known');await p.bill('old-known',30_000);
  await p.prepare('old-released');await f.store.call('releaseProviderCall',{id:'old-released',now:f.now()});
  await q.prepare('old-unknown');await f.store.call('dispatchProviderCall',{id:'old-unknown',now:f.now()});
  const closedAt=f.now();
  const before=await f.totals();
  assert.deepEqual([before.settledNanousd,before.reservedNanousd,before.availableNanousd],[30_000,COST,870_000]);
  const sweep=(receiptBefore:number)=>f.store.call('sweepRetention',{now:closedAt+400*DAY,resultBefore:0,diagnosticBefore:0,receiptBefore,limit:200});
  assert.equal((await sweep(closedAt-1)).receipts,0);
  assert.equal((await sweep(closedAt)).receipts,2);
  assert.equal(await f.store.call('providerCall',{id:'old-known'}),null);assert.equal(await f.store.call('providerCall',{id:'old-released'}),null);
  // The unanswered call and its reservation are evidence of a possible charge and stay.
  assert.equal((await f.store.call('providerCall',{id:'old-unknown'}))!.state,'DISPATCHED');
  assert.deepEqual(await f.totals(),before);
  assert.deepEqual(await f.store.call('attemptFunding',{attemptId:'a'}),{settledNanousd:30_000,heldNanousd:0});
  assert.equal((await sweep(closedAt+399*DAY)).receipts,0);
  const copy=join(f.dir,'backup.sqlite');await f.store.call('backup',{destination:copy});
  const restored=await Store.open(join(f.dir,'restored.sqlite'),copy);
  try{
    assert.deepEqual(await restored.call('fundingTotals',{}),before);
    // A restored database carries its history: the late bill still settles against the old reservation.
    await restored.call('receiveProviderCall',{id:'old-unknown',responseId:'resp_old',usage:usage(70_000),now:f.now()});
    assert.deepEqual([(await restored.call('fundingTotals',{})).settledNanousd,(await restored.call('fundingTotals',{})).reservedNanousd],[100_000,0]);
  }finally{await restored.close();}
  await f.reopen();
  assert.deepEqual(await f.totals(),before);
});

test('the storage command grants exact decimal dollars once per reference and reports the ledger read-only',async t=>{
  const f=await setup(t,null),run=promisify(execFile),cli=fileURLToPath(new URL('../storage/cli.js',import.meta.url));
  const storage=async(...args:string[])=>JSON.parse((await run(process.execPath,[cli,...args],{env:{PATH:process.env.PATH}})).stdout);
  assert.equal((await storage('funding',f.path)).ceilingNanousd,0);
  // 0.1 + 0.2 style inputs must not drift: amounts are parsed as text.
  assert.equal((await storage('grant',f.path,'0.30','owner-ref-0001')).ceilingNanousd,300_000_000);
  assert.equal((await storage('grant',f.path,'0.30','owner-ref-0001')).ceilingNanousd,300_000_000);
  assert.equal((await storage('grant',f.path,'2.000000001','owner-ref-0002')).ceilingNanousd,2_300_000_001);
  for(const args of [['grant',f.path,'0.30','owner-ref-0002'],['grant',f.path,'-1','owner-ref-0003'],['grant',f.path,'1e3','owner-ref-0003'],['grant',f.path,'0','owner-ref-0003'],
    ['grant',f.path,'1.0000000001','owner-ref-0003'],['grant',f.path,'5'],['grant',f.path,'5','short'],['grant',join(f.dir,'missing.sqlite'),'5','owner-ref-0003']])
    await assert.rejects(storage(...args),args.join(' '));
  assert.deepEqual([(await f.totals()).ceilingNanousd,(await f.totals()).grants],[2_300_000_001,2]);
});

test('a held liability for an ended call can be resolved once at a verified amount; in-flight and closed ones cannot',async t=>{
  const f=await setup(t),p=await f.phase('a');
  for(const call of ['timed-out','in-flight','answered']){await p.prepare(call);await f.store.call('dispatchProviderCall',{id:call,now:f.now()});}
  await f.store.call('finishProviderCall',{id:'timed-out',outcome:'TIMEOUT',now:f.now()});
  await f.store.call('receiveProviderCall',{id:'answered',responseId:'resp_a',usage:usage(10_000),now:f.now()});
  assert.deepEqual((await f.store.call('heldLiabilities',{})).map(h=>[h.callId,h.reservedNanousd,h.outcome]),[['in-flight',COST,null],['timed-out',COST,'TIMEOUT']]);
  const resolve=(callId:string,costNanousd:number,authorizationRef='owner-verified-0001')=>f.store.call('resolveLiability',{callId,costNanousd,authorizationRef,now:f.now()});
  await assert.rejects(resolve('in-flight',0),{code:'STORE_CONFLICT'});
  await assert.rejects(resolve('answered',0),{code:'STORE_CONFLICT'});
  await assert.rejects(resolve('missing',0),{code:'STORE_CONFLICT'});
  for(const [cost,ref] of [[-1,'owner-verified-0001'],[1.5,'owner-verified-0001'],[5,'short']] as const)await assert.rejects(resolve('timed-out',cost,ref),{code:'STORE_INVALID'});
  const after=await resolve('timed-out',42_000);
  assert.deepEqual([after.settledNanousd,after.unknownLiabilityNanousd,after.reservedNanousd],[52_000,0,COST]);
  await assert.rejects(resolve('timed-out',42_000),{code:'STORE_CONFLICT'});
  // If the provider's own bill turns up afterwards it is not charged a second time.
  await f.store.call('receiveProviderCall',{id:'timed-out',responseId:'resp_late',usage:usage(42_000),now:f.now()});
  assert.equal((await f.totals()).settledNanousd,52_000);
  assert.deepEqual(await f.store.call('attemptFunding',{attemptId:'a'}),{settledNanousd:52_000,heldNanousd:COST});
  assert.deepEqual((await f.store.call('operatorOverview',{})).audit.map(x=>[x.action,x.target,x.operatorId]),[['LIABILITY_RESOLVED','timed-out','cli:owner-verified-0001']]);
  // The command line does the same, and accepts a verified zero.
  await f.store.call('finishProviderCall',{id:'in-flight',outcome:'TRANSPORT_ERROR',now:f.now()});
  const run=promisify(execFile),cli=fileURLToPath(new URL('../storage/cli.js',import.meta.url));
  const storage=async(...args:string[])=>JSON.parse((await run(process.execPath,[cli,...args],{env:{PATH:process.env.PATH}})).stdout);
  assert.deepEqual((await storage('held',f.path)).map((h:{callId:string})=>h.callId),['in-flight']);
  assert.deepEqual([(await storage('resolve',f.path,'in-flight','0','owner-verified-0002')).unknownLiabilityNanousd,(await f.totals()).settledNanousd],[0,52_000]);
  await assert.rejects(storage('resolve',f.path,'in-flight','0'));
});
