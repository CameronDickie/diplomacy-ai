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
import { Store,hashToken } from '../storage/Store.js';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { challengeDefinition } from '../fixtures/ScenarioFixture.js';
import { recordedCall, type ProviderResponse } from '../providers/RecordedCall.js';
import type { ProviderCallIntent, ProviderUsage } from '../providers/accounting.js';

const now=1_800_000_000_000;
const known:ProviderUsage={inputTokens:100,cachedInputTokens:20,cacheWriteTokens:10,outputTokens:50,reasoningTokens:20,costNanousd:12345};
async function setup(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-provider-')),path=join(dir,'game.sqlite');
  let store=await Store.open(path);
  const fixture=JSON.parse(await readFile(new URL('../../fixtures/development/tunis-expedition.v1.json',import.meta.url),'utf8'));
  const content={definition:challengeDefinition(fixture)!,board:fixture.board};
  await store.call('registerChallenge',{...content,hash:createHash('sha256').update(canonicalJson(content)).digest('hex'),now});
  // Synthetic funds: every prepared call now needs a reservation (DIC-64).
  await store.call('grantFunding',{amountNanousd:1_000_000_000,authorizationRef:'test-grant-0001',grantedBy:'test',now});
  const player=await store.call('identity',{provider:'github',subject:'accounting-test',displayName:'Test',now});
  const attempt=await store.call('createAttempt',{id:'accounting-test',playerId:player.id,challengeId:content.definition.id,challengeVersion:1,reconnectTokenHash:hashToken('private-test-token'),now});
  const {job}=await store.call('beginPhase',{id:attempt.id,playerId:player.id,expectedRevision:0,phaseId:attempt.phaseId,operationId:'accounting-phase',requestId:'first-orders',action:{phase:'ORDERS',orderIds:['CON|HOLD','SMY|HOLD','ANK|HOLD']},now});
  const intent=(id:string):ProviderCallIntent=>({id,fence:{operationId:job.operationId,attemptId:job.attemptId,phaseId:job.phaseId,revision:job.revision},power:'FRANCE',provider:'OPENAI',model:'gpt-6-luna',role:'ORDERS',pricingVersion:'mock-price-v1',requestHash:hashToken(id),maxCostNanousd:100000});
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
  return {path,dir,player,attempt,job,intent,get store(){return store;},async reopen(){await store.close();store=await Store.open(path);},
    prepare:(id:string)=>store.call('prepareProviderCall',{intent:intent(id),now})};
}
const response=(id:string,outputText='{"valid":true}',usage:ProviderUsage|null=known):ProviderResponse=>({responseId:`resp_${id}`,usage,status:'COMPLETED',outputText});

test('billable malformed, invalid, refused, incomplete and successful output is recorded before interpretation',async t=>{
  const f=await setup(t);
  for(const outcome of ['INVALID_JSON','INVALID_ACTION','REFUSED','INCOMPLETE','PROVIDER_ERROR','VALID'] as const){
    await f.prepare(outcome);
    const r=response(outcome,outcome==='INVALID_JSON'?'SECRET-RAW-BODY':'{"valid":true}');
    if(outcome==='REFUSED'||outcome==='INCOMPLETE')r.status=outcome;
    if(outcome==='PROVIDER_ERROR')r.status='ERROR';
    let validated=false;
    const promise=recordedCall({store:f.store,id:outcome,signal:new AbortController().signal,timeoutMs:1000,now:()=>now,
      transport:async()=>r,validate:async value=>{
        validated=true;
        const saved=await f.store.call('providerCall',{id:outcome});assert.deepEqual(saved!.usage,known);assert.equal(saved!.state,'RECEIVED');
        if(outcome==='INVALID_ACTION')throw Error('SECRET-VALIDATION-ERROR');return value;
      }});
    if(outcome==='VALID')assert.deepEqual(await promise,{valid:true});
    else await assert.rejects(promise,(error:any)=>error.outcome===outcome&&!error.message.includes('SECRET'));
    assert.equal(validated,outcome==='INVALID_ACTION'||outcome==='VALID');
    const saved=await f.store.call('providerCall',{id:outcome});assert.equal(saved!.outcome,outcome);assert.deepEqual(saved!.usage,known);
    assert.ok(!JSON.stringify(saved).includes('SECRET'));
  }
  const totals=await f.store.call('providerCallTotals',{operationId:f.job.operationId});
  assert.equal(totals.calls,6);assert.equal(totals.knownCostNanousd,6*known.costNanousd);assert.equal(totals.unresolvedLiabilityNanousd,0);
});

test('atomic dispatch claims prevent duplicate transport and usage receipts sum exactly once across retry IDs and restart',async t=>{
  const f=await setup(t);await f.prepare('first');let transports=0;
  const run=()=>recordedCall({store:f.store,id:'first',signal:new AbortController().signal,timeoutMs:1000,now:()=>now,transport:async()=>{transports++;return response('first','{bad');},validate:x=>x});
  const results=await Promise.allSettled([run(),run()]);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(transports,1);
  const receive={id:'first',responseId:'resp_first',usage:known,now};
  await Promise.all([f.store.call('receiveProviderCall',receive),f.store.call('receiveProviderCall',receive)]);
  await assert.rejects(f.store.call('receiveProviderCall',{...receive,usage:{...known,costNanousd:1}}),{code:'STORE_CONFLICT'});
  await assert.rejects(f.store.call('prepareProviderCall',{intent:{...f.intent('first'),requestHash:hashToken('changed')},now}),{code:'STORE_CONFLICT'});
  await f.prepare('retry');await recordedCall({store:f.store,id:'retry',signal:new AbortController().signal,timeoutMs:1000,now:()=>now,transport:async()=>response('retry'),validate:x=>x});
  await f.reopen();await assert.rejects(run(),{code:'STORE_CONFLICT'});assert.equal(transports,1);
  const totals=await f.store.call('providerCallTotals',{operationId:f.job.operationId});assert.equal(totals.calls,2);assert.equal(totals.knownCostNanousd,known.costNanousd*2);
});

test('timeouts and transport failures remain liabilities; late usage settles after closure without replacing timeout outcome',async t=>{
  const f=await setup(t);await f.prepare('late');let resolve!:(r:ProviderResponse)=>void;
  const late=new Promise<ProviderResponse>(done=>{resolve=done;});
  await assert.rejects(recordedCall({store:f.store,id:'late',signal:new AbortController().signal,timeoutMs:20,now:()=>now,transport:()=>late,validate:()=>{throw Error('late validation must not run');}}),{outcome:'TIMEOUT'});
  await f.prepare('network');await assert.rejects(recordedCall({store:f.store,id:'network',signal:new AbortController().signal,timeoutMs:1000,now:()=>now,transport:async()=>{throw Error('SECRET-TRANSPORT');},validate:x=>x}),{outcome:'TRANSPORT_ERROR'});
  assert.equal((await f.store.call('providerCallTotals',{operationId:f.job.operationId})).unresolvedLiabilityNanousd,200000);
  await f.store.call('terminateAttempt',{id:f.attempt.id,playerId:f.player.id,lifecycle:'ABANDONED',now});
  resolve(response('late'));
  for(let i=0;i<100;i++){if((await f.store.call('providerCall',{id:'late'}))!.usage)break;await new Promise(done=>setTimeout(done,5));}
  const saved=await f.store.call('providerCall',{id:'late'});assert.equal(saved!.outcome,'TIMEOUT');assert.deepEqual(saved!.usage,known);
  await f.reopen();const totals=await f.store.call('providerCallTotals',{operationId:f.job.operationId});
  assert.equal(totals.knownCalls,1);assert.equal(totals.unresolvedCalls,1);assert.equal(totals.unresolvedLiabilityNanousd,100000);
});

test('partial/invalid usage is not free and strict metadata cannot persist raw output or hidden secrets',async t=>{
  const f=await setup(t);await f.prepare('missing');
  await recordedCall({store:f.store,id:'missing',signal:new AbortController().signal,timeoutMs:1000,now:()=>now,transport:async()=>response('missing','{}',null),validate:x=>x});
  assert.equal((await f.store.call('providerCallTotals',{operationId:f.job.operationId})).unresolvedLiabilityNanousd,100000);
  await assert.rejects(f.store.call('receiveProviderCall',{id:'missing',responseId:'resp_missing',usage:{...known,cachedInputTokens:101},now}),{code:'STORE_INVALID'});
  await assert.rejects(f.store.call('prepareProviderCall',{intent:{...f.intent('secret'),apiKey:'DO-NOT-STORE'} as any,now}),{code:'STORE_INVALID'});
  const backup=join(f.dir,'backup.sqlite');await f.store.call('backup',{destination:backup});
  const db=new DatabaseSync(backup,{readOnly:true});try{const rows=db.prepare('SELECT * FROM provider_calls').all();assert.ok(!JSON.stringify(rows).includes('DO-NOT-STORE'));}finally{db.close();}
});

test('dispatch rechecks phase revision and ban while existing billing can still settle after them',async t=>{
  for(const changed of ['revision','ban'] as const){
    const f=await setup(t);await f.prepare(changed);await f.prepare(`${changed}-sent`);
    await f.store.call('dispatchProviderCall',{id:`${changed}-sent`,now});
    if(changed==='revision')await f.store.call('recoverPhase',{fence:f.job,now});else await f.store.call('banPlayer',{playerId:f.player.id,banned:true,now});
    await assert.rejects(f.store.call('dispatchProviderCall',{id:changed,now}),{code:'STORE_CONFLICT'});
    await f.store.call('receiveProviderCall',{id:`${changed}-sent`,responseId:`resp_${changed}`,usage:known,now});
    assert.equal((await f.store.call('providerCallTotals',{operationId:f.job.operationId})).knownCostNanousd,known.costNanousd);
  }
});

test('actual process death preserves prepared, dispatched, received and finished evidence without redispatch',async t=>{
  for(const stage of ['PREPARED','DISPATCHED','RECEIVED','FINISHED']){
    const f=await setup(t);await f.prepare('crash');await f.store.close();
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/crashProvider.js',import.meta.url)),f.path,stage],{stdio:'ignore',env:{PATH:process.env.PATH}});
    const [code,signal]=await once(child,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');
    await f.reopen();const saved=await f.store.call('providerCall',{id:'crash'});assert.equal(saved!.state,stage);
    const totals=await f.store.call('providerCallTotals',{operationId:f.job.operationId});assert.equal(totals.calls,1);
    if(stage==='PREPARED'||stage==='DISPATCHED')assert.equal(totals.unresolvedLiabilityNanousd,100000);
    else assert.equal(totals.knownCostNanousd,12345);
    if(stage!=='PREPARED')await assert.rejects(f.store.call('dispatchProviderCall',{id:'crash',now}),{code:'STORE_CONFLICT'});
  }
});

test('separate database connections cannot claim one call twice or change its known receipt',async t=>{
  const f=await setup(t),other=await Store.open(f.path);t.after(()=>other.close());await f.prepare('shared');
  const claims=await Promise.allSettled([f.store.call('dispatchProviderCall',{id:'shared',now}),other.call('dispatchProviderCall',{id:'shared',now})]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  const receipt={id:'shared',responseId:'resp_shared',usage:known,now};
  await Promise.all([f.store.call('receiveProviderCall',receipt),other.call('receiveProviderCall',receipt)]);
  assert.equal((await f.store.call('providerCallTotals',{operationId:f.job.operationId})).knownCostNanousd,known.costNanousd);
  const rows=await other.call('providerCallsForOperation',{operationId:f.job.operationId});assert.equal(rows.length,1);assert.deepEqual(rows[0].usage,known);
  await assert.rejects(f.store.call('prepareProviderCall',{intent:{...f.intent('human'),power:'TURKEY'},now}),{code:'STORE_CONFLICT'});
});

test('cancellation during async validation retains known billing and cannot become a late valid decision',async t=>{
  const f=await setup(t);await f.prepare('cancel');const controller=new AbortController();
  let release!:()=>void,started!:()=>void;
  const ready=new Promise<void>(done=>{started=done;}),pending=new Promise<void>(done=>{release=done;});
  const result=recordedCall({store:f.store,id:'cancel',signal:controller.signal,timeoutMs:1000,now:()=>now,transport:async()=>response('cancel'),validate:async()=>{started();await pending;return 'late';}});
  await ready;controller.abort();await assert.rejects(result,{outcome:'CANCELLED'});release();
  await new Promise(done=>setImmediate(done));
  const saved=await f.store.call('providerCall',{id:'cancel'});assert.equal(saved!.outcome,'CANCELLED');assert.deepEqual(saved!.usage,known);
});

test('usage above its estimate is retained in full rather than clipped to the estimate',async t=>{
  const f=await setup(t);await f.prepare('over');await f.store.call('dispatchProviderCall',{id:'over',now});
  const actual={...known,costNanousd:200000};
  await f.store.call('receiveProviderCall',{id:'over',responseId:'resp_over',usage:actual,now});
  assert.equal((await f.store.call('providerCallTotals',{operationId:f.job.operationId})).knownCostNanousd,200000);
});
