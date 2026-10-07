import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../storage/Store.js';
import { evaluate,TARGETS } from '../evaluation/Harness.js';
import { LIVE_ATTEMPT_LIMIT,format,liveTransport } from '../evaluation/cli.js';
import { mockLunaTransport,type LunaTransport } from '../luna/Transport.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PhaseRules } from '../attempts/PhaseRules.js';
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
const stable=(report:Awaited<ReturnType<typeof evaluate>>)=>JSON.stringify({...report,attempts:report.attempts.map(a=>({...a,phaseMs:a.phaseMs.length,phaseTimings:a.phaseTimings.map(({operationId,...p})=>p)})),summary:{...report.summary,phaseP50Ms:0,phaseP95Ms:0},targets:report.targets.map(x=>x.name)});

test('a mock run needs no key, plays whole attempts, reconciles to the ledger and is reproducible from its seed',async t=>{
  const outbound:string[]=[],realFetch=globalThis.fetch;
  globalThis.fetch=((input:Parameters<typeof fetch>[0])=>{outbound.push(String(input));throw new Error('no network in evaluation tests');}) as typeof fetch;
  t.after(()=>{globalThis.fetch=realFetch;});
  const a=await setup(t),b=await setup(t);
  const first=await evaluate(a.base(mockLunaTransport({pick:'seeded',seed:5}))),second=await evaluate(b.base(mockLunaTransport({pick:'seeded',seed:5})));
  assert.equal(stable(first),stable(second));
  assert.deepEqual(first.manifest,{runId:'run-a',transport:'mock',scenario:'tunis-expedition',scenarioVersion:1,script:'early-capture',seed:5,presetId:LUNA_PRESET.id,pricingVersion:LUNA_PRESET.pricingVersion,
    contextVersion:'luna-context-v1',model:'gpt-6-luna',attemptsRequested:2,maxRecoveries:2,fixtureHash:first.manifest.fixtureHash,presetHash:first.manifest.presetHash,harnessVersion:'luna-evaluation-v4',timingPolicy:'wall-submission-commit-v1'});
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
  assert.deepEqual(two.attempts[0].phaseMs,one.attempts[0].phaseMs,'completed phase timing survives reopening');
  assert.equal(two.attempts[0].recoveries,one.attempts[0].recoveries);
  assert.equal(calls-afterOne,two.attempts[1].calls);
  assert.equal(two.ledger.reconciles,true);assert.equal(two.ledger.attributedNanousd,two.attempts[1].settledNanousd);
  assert.equal((await f.store.call('fundingTotals',{})).settledNanousd,settledOne+two.attempts[1].settledNanousd);
  // Asking again changes nothing and calls nothing.
  const before=calls,again=await evaluate({...f.base(counting,{attempts:2}),store:f.store});
  assert.equal(calls,before);assert.deepEqual([again.ledger.attributedNanousd,again.ledger.reconciles],[0,true]);
  assert.deepEqual(again.summary,two.summary,'resumed summary retains its timing evidence');
  for(const changed of [{seed:6},{script:'deadline-hold'},{transportKind:'live'},{maxRecoveries:1}])
    await assert.rejects(evaluate({...f.base(counting,{attempts:2,...changed}),store:f.store}),{code:'STORE_CONFLICT'});
  assert.equal(calls,before,'manifest refusal cannot dispatch anything');
});

test('failures, unanswered calls and an empty pool are reported as such and counted against the targets',async t=>{
  const f=await setup(t);const mock=mockLunaTransport();let n=0;
  // Every fifth answer is unusable and every eleventh never arrives; then the provider goes away for good.
  // The outage is what stops the attempt: with concurrent powers, which one draws a bad answer is not ordered.
  const flaky:LunaTransport=async request=>{n++;if(n%11===0||n>24)throw new Error('socket closed');const response=await mock(request);
    if(n%5===0)(response.body as {output:Array<{content:Array<{text:string}>}>}).output[0].content[0].text='not json';return response;};
  const report=await evaluate(f.base(flaky,{attempts:1,script:'deadline-hold'}));
  const [attempt]=report.attempts;
  assert.ok((attempt.callOutcomes.INVALID_JSON??0)>0&&(attempt.callOutcomes.TRANSPORT_ERROR??0)>0,JSON.stringify(attempt.callOutcomes));
  assert.ok(attempt.recoveries>0);
  // Unusable answers were still billed; unanswered ones are still held at their worst case.
  assert.ok(attempt.heldNanousd>0);assert.equal(report.summary.heldNanousd,attempt.heldNanousd);
  assert.ok(report.summary.retryOrFailureRate!>TARGETS.retryOrFailureRate);
  assert.equal(attempt.lifecycle,'STOPPED');
  assert.equal(report.summary.meanAttemptCostNanousd,null,'a truncated attempt cannot pass the full-game cost target');
  assert.deepEqual(report.targets.map(x=>x.met),[null,null,false]);
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


test('SIGKILL after acceptance, a counted recovery and commit preserves benchmark evidence across resume',async t=>{
  for(const stage of ['INTENT','RECOVERED','COMMITTED']){
    const f=await setup(t),child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/crashEvaluation.js',import.meta.url)),f.path,stage],{stdio:'ignore',env:{PATH:process.env.PATH}});
    const [code,signal]=await once(child,'exit');assert.equal(code,null,stage);assert.equal(signal,'SIGKILL',stage);
    const phases=await f.store.call('evaluationPhases',{attemptId:'eval-crash-run-1'});assert.equal(phases.length,1,stage);
    const first=phases[0];assert.equal(first.recoveries,stage==='RECOVERED'?1:0,stage);
    assert.equal(first.completedAt!==null,stage==='COMMITTED',stage);
    const calls=await f.store.call('providerCallsForAttempt',{attemptId:'eval-crash-run-1'});
    const settled=(await f.store.call('fundingTotals',{})).settledNanousd;
    await f.reopen();
    const options={store:f.store,transport:mockLunaTransport({pick:'first',seed:5}),transportKind:'mock' as const,runId:'crash-run',scenario:'tunis-expedition',script:'early-capture',attempts:1,seed:5};
    const report=await evaluate(options),[attempt]=report.attempts;
    assert.equal(attempt.lifecycle,'COMPLETED',stage);assert.equal(attempt.phaseMs.length,attempt.phases,stage);assert.deepEqual(attempt.timingIssues,[],stage);
    assert.equal(attempt.recoveries,stage==='COMMITTED'?0:stage==='RECOVERED'?2:1,stage);
    assert.equal(attempt.phaseTimings[0].startedAt,first.startedAt,stage);
    if(stage==='COMMITTED')assert.deepEqual(attempt.phaseTimings[0],first,stage);
    assert.equal(report.ledger.reconciles,true,stage);assert.equal(report.ledger.attributedNanousd,attempt.settledNanousd-settled,stage);
    const after=await f.store.call('providerCallsForAttempt',{attemptId:attempt.id});
    for(const call of calls)assert.deepEqual(after.find(c=>c.id===call.id),call,stage);
    const again=await evaluate(options);assert.deepEqual(again.attempts,report.attempts,stage);assert.deepEqual(again.summary,report.summary,stage);
    assert.equal(again.ledger.attributedNanousd,0,stage);
  }
});

test('a backwards wall clock does not fail the game or fabricate a passing latency',async t=>{
  const f=await setup(t);let i=0;
  const report=await evaluate(f.base(mockLunaTransport(),{attempts:1,clock:()=>++i%2?100:50}));
  assert.equal(report.attempts[0].lifecycle,'COMPLETED');assert.ok(report.attempts[0].phases>0);
  assert.equal(report.summary.timedPhases,0);assert.equal(report.summary.phaseP95Ms,null);
  assert.equal(report.targets[1].met,null);assert.ok(report.notes.some(n=>/clock regressed/.test(n)));
  assert.ok(report.attempts[0].phaseTimings.every(p=>p.completedAt===50&&p.startedAt===100&&p.durationMs===null));
});

test('evaluation configuration and completed timing are immutable and backup preserves both',async t=>{
  const f=await setup(t),options=f.base(mockLunaTransport(),{attempts:1}),one=await evaluate(options);
  const manifest=await f.store.call('evaluationRun',{runId:'run-a'}),{attemptsRequested,...identity}=one.manifest;
  assert.deepEqual(manifest,identity);assert.match(identity.fixtureHash,/^[a-f0-9]{64}$/);assert.match(identity.presetHash,/^[a-f0-9]{64}$/);
  const db=new DatabaseSync(f.path);
  try{
    for(const table of ['evaluation_runs','evaluation_attempts','evaluation_phases'])assert.throws(()=>db.exec(`DELETE FROM ${table}`),/permanent/);
    assert.throws(()=>db.exec("UPDATE evaluation_runs SET manifest_json='{}'"),/immutable/);
    assert.throws(()=>db.exec("UPDATE evaluation_attempts SET ordinal=99"),/immutable/);
    assert.throws(()=>db.exec("UPDATE evaluation_phases SET duration_ms=0"),/immutable/);
  }finally{db.close();}
  await assert.rejects(f.store.call('registerEvaluationRun',{manifest:{...identity,fixtureHash:'a'.repeat(64)},now:1}),{code:'STORE_CONFLICT'});
  await assert.rejects(f.store.call('registerEvaluationRun',{manifest:{...identity,presetHash:'b'.repeat(64)},now:1}),{code:'STORE_CONFLICT'});
  const backup=join(f.dir,'backup.sqlite'),restored=join(f.dir,'restored.sqlite');await f.store.call('backup',{destination:backup});
  const restoredStore=await Store.open(restored,backup);
  try{
    const replay=await evaluate({...options,store:restoredStore});assert.deepEqual(replay.attempts,one.attempts);assert.deepEqual(replay.summary,one.summary);assert.equal(replay.ledger.attributedNanousd,0);
  }finally{await restoredStore.close();}
  // Raw result retention does not allow the same run identity to buy an expired attempt again.
  await f.store.call('sweepRetention',{now:1_800_000_000_001,resultBefore:1_800_000_000_001,diagnosticBefore:1_800_000_000_001,receiptBefore:0,limit:100});
  assert.equal(await f.store.call('attempt',{id:one.attempts[0].id}),null);
  await assert.rejects(evaluate(options),{code:'STORE_CONFLICT'});
  assert.equal((await f.store.call('fundingTotals',{})).settledNanousd,one.summary.settledNanousd);
});


test('restart cannot reset the per-phase recovery cap or change a stalled result into success',async t=>{
  const f=await setup(t),child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/crashEvaluation.js',import.meta.url)),f.path,'MAX_RECOVERIES'],{stdio:'ignore',env:{PATH:process.env.PATH}});
  const [code,signal]=await once(child,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');
  const calls=await f.store.call('providerCallsForAttempt',{attemptId:'eval-crash-run-1'});assert.ok(calls.length>0&&calls.length<=12);
  assert.equal((await f.store.call('evaluationPhases',{attemptId:'eval-crash-run-1'}))[0].recoveries,2);
  await f.reopen();let sent=0;const mock=mockLunaTransport();
  const transport:LunaTransport=async request=>{sent++;return mock(request);};
  const options={store:f.store,transport,transportKind:'mock' as const,runId:'crash-run',scenario:'tunis-expedition',script:'early-capture',attempts:1,seed:5};
  const report=await evaluate(options),again=await evaluate(options);
  assert.equal(sent,0);assert.equal((await f.store.call('providerCallsForAttempt',{attemptId:'eval-crash-run-1'})).length,calls.length);assert.equal(report.attempts[0].recoveries,2);assert.equal(report.attempts[0].stalled,true);assert.equal(report.attempts[0].lifecycle,'STOPPED');
  assert.deepEqual(again.attempts,report.attempts);assert.deepEqual(again.summary,report.summary);assert.equal(report.ledger.attributedNanousd,0);
});


test('local interruption returns private-safe partial evidence and resumes the same paid attempt',async t=>{
  const f=await setup(t),original=PhaseRules.prototype.legal;let fail=false,sent=0;
  t.after(()=>{PhaseRules.prototype.legal=original;});
  PhaseRules.prototype.legal=async function(...args){
    if(fail)throw new Error('secret-key private-player-chat raw-provider-content');
    return original.apply(this,args);
  };
  const mock=mockLunaTransport(),transport:LunaTransport=async request=>{sent++;return mock(request);};
  const report=await evaluate(f.base(transport,{boundary:async(stage:string)=>{if(stage==='committed')fail=true;}}));
  assert.equal(report.status,'INTERRUPTED');assert.equal(report.attempts.length,1);
  const first=report.attempts[0];assert.equal(first.lifecycle,'ACTIVE');assert.equal(first.interrupted,true);
  assert.equal(first.phases,1);assert.equal(first.calls,sent);assert.ok(first.settledNanousd>0);
  assert.equal(report.ledger.reconciles,true);assert.equal(report.summary.meanAttemptCostNanousd,null);
  assert.deepEqual(report.targets.map(t=>t.met),[null,null,null]);
  assert.doesNotMatch(JSON.stringify(report),/secret-key|private-player-chat|raw-provider-content/);
  assert.match(format(report),/Status INTERRUPTED/);
  assert.equal(await f.store.call('attempt',{id:'eval-run-a-2'}),null);
  const phases=first.phaseTimings,calls=await f.store.call('providerCallsForAttempt',{attemptId:first.id});
  fail=false;await f.reopen();
  const resumed=await evaluate({...f.base(transport,{attempts:1}),store:f.store});
  assert.equal(resumed.status,'FINISHED');assert.equal(resumed.attempts[0].lifecycle,'COMPLETED');
  assert.equal(resumed.attempts[0].interrupted,false);assert.deepEqual(resumed.attempts[0].phaseTimings[0],phases[0]);
  const after=await f.store.call('providerCallsForAttempt',{attemptId:first.id});
  for(const call of calls)assert.deepEqual(after.find(c=>c.id===call.id),call);
  assert.equal(resumed.ledger.attributedNanousd,resumed.summary.settledNanousd-first.settledNanousd);
  const before=sent,again=await evaluate({...f.base(transport,{attempts:1}),store:f.store});
  assert.equal(sent,before);assert.deepEqual(again.summary,resumed.summary);assert.equal(again.ledger.attributedNanousd,0);
});


test('interrupted reports retain observed latency misses and uncertain billed liabilities',async t=>{
  const f=await setup(t),original=PhaseRules.prototype.legal;let committed=false,sent=0,tick=0;
  t.after(()=>{PhaseRules.prototype.legal=original;});
  PhaseRules.prototype.legal=async function(...args){if(committed)throw new Error('local rules failure');return original.apply(this,args);};
  const mock=mockLunaTransport(),transport:LunaTransport=async request=>{
    if(++sent===1)throw new Error('unanswered generation');return mock(request);
  };
  const report=await evaluate(f.base(transport,{attempts:1,clock:()=>(tick+=40_000),boundary:async(stage:string)=>{if(stage==='committed')committed=true;}}));
  assert.equal(report.status,'INTERRUPTED');assert.equal(report.attempts[0].lifecycle,'ACTIVE');
  assert.ok(report.summary.heldNanousd>0);assert.equal(report.attempts[0].callOutcomes.TRANSPORT_ERROR,1);
  assert.deepEqual(report.targets.map(t=>t.met),[null,false,false]);
  const totals=await f.store.call('fundingTotals',{});
  assert.equal(totals.settledNanousd,report.summary.settledNanousd);
  assert.equal(totals.unknownLiabilityNanousd+totals.reservedNanousd,report.summary.heldNanousd);
  assert.equal(report.ledger.reconciles,true);
});


test('the concurrent policy refuses to adopt v2 or v3 runs before dispatch',async t=>{
  const source=await setup(t),first=await evaluate(source.base(mockLunaTransport(),{attempts:1}));
  const {attemptsRequested,...manifest}=first.manifest;
  for(const harnessVersion of ['luna-evaluation-v2','luna-evaluation-v3']){
    const old=await setup(t);await old.store.call('registerEvaluationRun',{manifest:{...manifest,harnessVersion},now:1});
    let dispatched=0;const mock=mockLunaTransport(),transport:LunaTransport=async request=>{dispatched++;return mock(request);};
    await assert.rejects(evaluate(old.base(transport)),{code:'STORE_CONFLICT'});
    assert.equal(dispatched,0);assert.equal((await old.store.call('fundingTotals',{})).settledNanousd,0);
  }
});
