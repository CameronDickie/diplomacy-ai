import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../storage/Store.js';
import { evaluate,TARGETS } from '../evaluation/Harness.js';
import { LIVE_ATTEMPT_LIMIT,format,liveTransport } from '../evaluation/cli.js';
import { mockLunaTransport,type LunaTransport } from '../luna/Transport.js';
import { LUNA_PRESET } from '../providers/LunaPreset.js';

async function setup(t:test.TestContext,granted=1_000_000_000){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-evaluation-')),path=join(dir,'game.sqlite');let store=await Store.open(path);
  if(granted)await store.call('grantFunding',{amountNanousd:granted,authorizationRef:'owner-eval-0001',grantedBy:'test',now:1});
  let tick=0;
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
  // A fake clock makes latency deterministic: every reading advances 25 ms.
  const base=(transport:LunaTransport,extra:Record<string,unknown>={})=>({store,transport,transportKind:'mock' as const,runId:'run-a',scenario:'tunis-expedition',script:'early-capture',attempts:2,seed:5,now:()=>1_800_000_000_000,clock:()=>(tick+=25),...extra});
  return {dir,path,base,get store(){return store;},async reopen(){await store.close();store=await Store.open(path);}};
}
const stable=(report:Awaited<ReturnType<typeof evaluate>>)=>JSON.stringify({...report,attempts:report.attempts.map(a=>({...a,phaseMs:a.phaseMs.length})),summary:{...report.summary,phaseP50Ms:0,phaseP95Ms:0},targets:report.targets.map(x=>x.name)});

test('a mock run needs no key, plays whole attempts, reconciles to the ledger and is reproducible from its seed',async t=>{
  const outbound:string[]=[],realFetch=globalThis.fetch;
  globalThis.fetch=((input:Parameters<typeof fetch>[0])=>{outbound.push(String(input));throw new Error('no network in evaluation tests');}) as typeof fetch;
  t.after(()=>{globalThis.fetch=realFetch;});
  const a=await setup(t),b=await setup(t);
  const first=await evaluate(a.base(mockLunaTransport({pick:'seeded',seed:5}))),second=await evaluate(b.base(mockLunaTransport({pick:'seeded',seed:5})));
  assert.equal(stable(first),stable(second));
  assert.deepEqual(first.manifest,{runId:'run-a',transport:'mock',scenario:'tunis-expedition',scenarioVersion:1,script:'early-capture',seed:5,presetId:LUNA_PRESET.id,pricingVersion:LUNA_PRESET.pricingVersion,
    contextVersion:'luna-context-v1',model:'gpt-6-luna',attemptsRequested:2,maxRecoveries:2});
  assert.equal(first.attempts.length,2);
  for(const attempt of first.attempts){
    // Each attempt ran to a scored end, not just one phase.
    assert.ok(['SUCCESS','FAILURE'].includes(attempt.outcome),attempt.outcome);assert.equal(attempt.lifecycle,'COMPLETED');assert.equal(attempt.stalled,false);
    assert.ok(attempt.phases>=4&&attempt.phaseMs.length===attempt.phases);assert.ok(attempt.calls>=attempt.phases);
    assert.equal(attempt.callOutcomes.VALID,attempt.calls);assert.equal(attempt.heldNanousd,0);
    // Real bills are far below the worst case that was reserved for them.
    assert.ok(attempt.settledNanousd>0&&attempt.settledNanousd<attempt.reservedEstimateNanousd);
  }
  const s=first.summary;
  assert.equal(s.settledNanousd,first.attempts.reduce((n,x)=>n+x.settledNanousd,0));
  assert.deepEqual([first.ledger.reconciles,first.ledger.attributedNanousd,first.ledger.settledAfterNanousd-first.ledger.settledBeforeNanousd],[true,s.settledNanousd,s.settledNanousd]);
  assert.equal((await a.store.call('fundingTotals',{})).settledNanousd,s.settledNanousd);
  assert.deepEqual([s.legalityRate,s.retryOrFailureRate,s.stalled],[1,0,0]);
  assert.deepEqual(first.targets.map(x=>x.met),[true,true,true]);
  assert.ok(first.notes.some(n=>/Mock transport/.test(n))&&first.notes.some(n=>/too small/.test(n)));
  assert.match(format(first),/MOCK transport[\s\S]*Ledger reconciles[\s\S]*met {3}Mean attempt cost/);
  assert.equal((await a.store.call('activeAttempts',{})).length,0);
  assert.deepEqual(outbound,[]);
  // A different seed is a different game.
  const c=await setup(t),other=await evaluate(c.base(mockLunaTransport({pick:'seeded',seed:99})));
  assert.notEqual(stable(other),stable(first));
});

test('re-running a run ID reads finished attempts back and recovers an interrupted one without buying anything twice',async t=>{
  const f=await setup(t);let calls=0;const mock=mockLunaTransport({pick:'seeded',seed:5});
  const counting:LunaTransport=async request=>{calls++;return mock(request);};
  const one=await evaluate(f.base(counting,{attempts:1}));
  const afterOne=calls,settledOne=one.summary.settledNanousd;assert.ok(afterOne>0);
  // Same run, asking for two: the first is read back untouched, only the second is played.
  await f.reopen();
  const two=await evaluate({...f.base(counting,{attempts:2}),store:f.store});
  assert.equal(two.attempts.length,2);assert.equal(stable({...two,attempts:[two.attempts[0]]} as never).includes(one.attempts[0].id),true);
  assert.deepEqual([two.attempts[0].settledNanousd,two.attempts[0].calls],[one.attempts[0].settledNanousd,one.attempts[0].calls]);
  assert.equal(calls-afterOne,two.attempts[1].calls);
  assert.equal(two.ledger.reconciles,true);assert.equal(two.ledger.attributedNanousd,two.attempts[1].settledNanousd);
  assert.equal((await f.store.call('fundingTotals',{})).settledNanousd,settledOne+two.attempts[1].settledNanousd);
  // Asking again changes nothing and calls nothing.
  const before=calls,again=await evaluate({...f.base(counting,{attempts:2}),store:f.store});
  assert.equal(calls,before);assert.deepEqual([again.ledger.attributedNanousd,again.ledger.reconciles],[0,true]);
});

test('failures, unanswered calls and an empty pool are reported as such and counted against the targets',async t=>{
  const f=await setup(t);const mock=mockLunaTransport();let n=0;
  // Every fifth answer is unusable and every eleventh never arrives.
  const flaky:LunaTransport=async request=>{n++;if(n%11===0)throw new Error('socket closed');const response=await mock(request);
    if(n%5===0)(response.body as {output:Array<{content:Array<{text:string}>}>}).output[0].content[0].text='not json';return response;};
  const report=await evaluate(f.base(flaky,{attempts:1,script:'deadline-hold'}));
  const [attempt]=report.attempts;
  assert.ok((attempt.callOutcomes.INVALID_JSON??0)>0&&(attempt.callOutcomes.TRANSPORT_ERROR??0)>0,JSON.stringify(attempt.callOutcomes));
  assert.ok(attempt.recoveries>0);
  // Unusable answers were still billed; unanswered ones are still held at their worst case.
  assert.ok(attempt.heldNanousd>0);assert.equal(report.summary.heldNanousd,attempt.heldNanousd);
  assert.ok(report.summary.retryOrFailureRate!>TARGETS.retryOrFailureRate);
  assert.deepEqual(report.targets.map(x=>x.met),[true,true,false]);
  assert.match(format(report),/MISS {2}Calls that were not a valid decision/);
  assert.equal(report.ledger.reconciles,true);
  const totals=await f.store.call('fundingTotals',{});
  assert.deepEqual([totals.settledNanousd,totals.unknownLiabilityNanousd+totals.reservedNanousd],[attempt.settledNanousd,attempt.heldNanousd]);
  // With no funds the run stops before starting and says why, instead of reporting an empty success.
  const empty=await setup(t,0),none=await evaluate(empty.base(mockLunaTransport()));
  assert.equal(none.attempts.length,0);assert.ok(none.notes.some(x=>/paused or unfunded/.test(x)));
  assert.deepEqual(none.targets.map(x=>x.met),[null,null,null]);
  await assert.rejects(evaluate(f.base(mock,{runId:'Bad ID'})),/Run ID/);
  await assert.rejects(evaluate(f.base(mock,{attempts:0})),/Attempts/);
  await assert.rejects(evaluate(f.base(mock,{script:'no-such-script',runId:'run-b'})),/no script/);
  await assert.rejects(evaluate(f.base(mock,{scenario:'../../etc/passwd',runId:'run-c'})),/Unknown scenario/);
});

test('a live run is refused unless the flag, key, existing database and a matching recorded grant are all present',async t=>{
  const f=await setup(t);let fetched=0;const fetchImpl=(async()=>{fetched++;return new Response('{}');}) as typeof fetch;
  const ok={live:true,db:f.path,authorizationRef:'owner-eval-0001',attempts:3,apiKey:'test-key-not-real',fetchImpl};
  assert.equal(liveTransport({...ok,live:false}),null);
  assert.throws(()=>liveTransport({...ok,authorizationRef:undefined}),/authorization-ref/);
  assert.throws(()=>liveTransport({...ok,apiKey:undefined}),/provider key/);
  assert.throws(()=>liveTransport({...ok,attempts:LIVE_ATTEMPT_LIMIT+1}),/limited to/);
  assert.throws(()=>liveTransport({...ok,db:join(f.dir,'fresh.sqlite')}),/existing ledger database/);
  assert.throws(()=>liveTransport({...ok,authorizationRef:'some-other-reference'}),/No funding grant/);
  // All conditions met yields a transport; constructing it sends nothing.
  assert.equal(typeof liveTransport(ok),'function');assert.equal(fetched,0);
});
