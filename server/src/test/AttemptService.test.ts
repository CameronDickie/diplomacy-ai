import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ALL_POWERS } from '@diplomacy/shared';
import type { PhaseAction } from '../attempts/types.js';
import { Store, hashToken, newToken } from '../storage/Store.js';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { importScenario, challengeDefinition } from '../fixtures/ScenarioFixture.js';
import { AttemptService, offlineDecisions, type DecisionProvider } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseDecisions, PhaseJob } from '../attempts/types.js';

const now=1_800_000_000_000;
async function setup(name='tunis-expedition') {
  const directory=mkdtempSync(resolve(tmpdir(),'diplomacy-phases-')), path=resolve(directory,'game.sqlite');
  let store=await Store.open(path);
  const raw=JSON.parse(readFileSync(new URL(`../../fixtures/development/${name}.v1.json`,import.meta.url),'utf8'));
  raw.objective ??= {humanPower:name==='retreat-position'?'GERMANY':'FRANCE',territory:'TUN',deadlineYear:1905,earlyAchievementYear:1902};
  const fixture=await importScenario(raw);
  const definition=challengeDefinition(fixture)!;
  const content={definition,board:fixture.board};
  await store.call('registerChallenge',{...content,hash:createHash('sha256').update(canonicalJson(content)).digest('hex'),now});
  const player=await store.call('identity',{provider:'github',subject:'phase-test',displayName:'Test',now});
  const attempt=await store.call('createAttempt',{id:'phase-test',playerId:player.id,challengeId:definition.id,challengeVersion:1,reconnectTokenHash:hashToken(newToken()),now});
  const rules=new PhaseRules();
  const action:PhaseAction=attempt.board.phase==='ORDERS' ? {phase:'ORDERS',orderIds:(await rules.legal(attempt.board,definition.humanPower,new AbortController().signal)).filter(o=>o.order.type==='HOLD').map(o=>o.id)} : attempt.board.phase==='RETREATS' ? {phase:'RETREATS',retreats:Object.fromEntries(attempt.board.units.filter(u=>u.power===definition.humanPower && u.mustRetreat).map(u=>[u.id,null]))} : {phase:'BUILDS',builds:[],disbands:[]};
  const input={attemptId:attempt.id,playerId:player.id,revision:attempt.revision,phaseId:attempt.phaseId,requestId:'request-1',action};
  return {path,attempt,player,rules,input,fixture, get store(){return store;}, async reopen(){await store.close();store=await Store.open(path);return store;},
    async close(){await store.close();rmSync(directory,{recursive:true,force:true});}};
}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

test('accepted concurrent duplicates run one phase; changed IDs and stale commands cannot replace saved orders',async()=>{
  const f=await setup();let calls=0;
  const rules=f.rules, fallback=offlineDecisions(rules), started=deferred<PhaseJob>(), release=deferred<PhaseDecisions>();
  const service=new AttemptService(f.store,{decide:async({job})=>{calls++;started.resolve(job);return release.promise;},recover:fallback.recover},rules);
  try {
    const receipts=await Promise.all([service.submit(f.input),service.submit(f.input)]);
    assert.deepEqual(receipts[0],receipts[1]);assert.equal(receipts[0].state.status,'SUBMITTING');
    const frozen=await started.promise;
    assert.ok(Object.isFrozen(frozen.board.units));
    assert.throws(()=>{frozen.board.units.length=0;});
    assert.equal((await f.store.call('attempt',{id:f.attempt.id}))!.board.season,'SPRING');
    assert.equal((await f.store.call('reports',{attemptId:f.attempt.id})).length,0);
    await assert.rejects(service.submit({...f.input,action:{phase:'ORDERS',orderIds:[]}}),{code:'STORE_CONFLICT'});
    await assert.rejects(service.submit({...f.input,requestId:'new-request'}),{code:'STORE_CONFLICT'});
    release.resolve(await rules.defaults(frozen,new AbortController().signal));await service.wait(f.attempt.id);
    assert.equal(calls,1);
    const saved=(await f.store.call('attempt',{id:f.attempt.id}))!;
    assert.equal(saved.board.season,'FALL');assert.equal(saved.execution,'ACCEPTING');assert.equal(saved.revision,3);
    const receipt=await service.submit(f.input);assert.equal(receipt.state.status,'ACCEPTED');
    await service.close();await f.reopen();
    const restarted=new AttemptService(f.store,fallback,rules);
    try {assert.deepEqual(await restarted.submit(f.input),receipt);await restarted.recover();assert.equal((await f.store.call('reports',{attemptId:f.attempt.id})).length,1);}
    finally {await restarted.close();}
  } finally {release.resolve({});await service.close();await f.close();}
});

test('late provider results after abandonment, expiry, stop, or ban never change a committed board',async()=>{
  for(const termination of ['ABANDONED','EXPIRED','STOPPED','BAN'] as const){
    const f=await setup(), started=deferred<PhaseJob>(), result=deferred<PhaseDecisions>();let signal:AbortSignal|undefined;
    const fallback=offlineDecisions(f.rules);
    const service=new AttemptService(f.store,{decide:async ctx=>{signal=ctx.signal;started.resolve(ctx.job);return result.promise;},recover:fallback.recover},f.rules,{timeoutMs:5000});
    try{
      await service.submit(f.input);const job=await started.promise;
      const choices=await f.rules.defaults(job,new AbortController().signal);
      if(termination==='BAN')await service.banPlayer(f.player.id);
      else await service.terminate(f.attempt.id,f.player.id,termination);
      assert.ok(signal?.aborted,'closing an attempt aborts its local provider request immediately');
      result.resolve(choices);await service.wait(f.attempt.id);
      const ended=(await f.store.call('attempt',{id:f.attempt.id}))!;
      assert.equal(ended.lifecycle,termination==='BAN'?'STOPPED':termination);assert.deepEqual(ended.board,f.attempt.board);
      assert.equal((await f.store.call('reports',{attemptId:f.attempt.id})).length,0);
      assert.equal((await f.store.call('pendingPhaseJobs',{})).length,0);
      assert.equal((await f.store.call('receipt',{attemptId:f.attempt.id,playerId:f.player.id,requestId:f.input.requestId}))!.state.error?.code,'ATTEMPT_CLOSED');
      await assert.rejects(f.store.call('saveDecisions',{fence:job,decisions:choices,now}),{code:'STORE_CONFLICT'});
    }finally{result.resolve({});await service.close();await f.close();}
  }
});

test('timeout preserves accepted input; recovery reconciles the same operation and ignores the late original result',async()=>{
  const f=await setup(), started=deferred<PhaseJob>(), late=deferred<PhaseDecisions>();let recovered:string|undefined;
  const provider:DecisionProvider={decide:async({job})=>{started.resolve(job);return late.promise;},recover:async ctx=>{recovered=ctx.job.operationId;return f.rules.defaults(ctx.job,ctx.signal);}};
  const service=new AttemptService(f.store,provider,f.rules,{timeoutMs:500});
  try{
    await service.submit(f.input);const original=await started.promise;await service.wait(f.attempt.id);
    const pending=(await f.store.call('pendingPhaseJobs',{}))[0];assert.equal(pending.status,'RECOVERING');assert.ok(pending.revision>original.revision);
    const receipt=await service.submit(f.input);assert.equal(receipt.state.status,'SUBMITTING');assert.equal(receipt.state.error?.code,'RECOVERY_REQUIRED');
    await service.close();await f.reopen();
    const resumed=new AttemptService(f.store,provider,f.rules);
    try{
      await resumed.recover();assert.equal(recovered,original.operationId);
      const saved=await f.store.call('attempt',{id:f.attempt.id});assert.equal(saved!.board.season,'FALL');
      late.resolve(await f.rules.defaults(original,new AbortController().signal));await new Promise(done=>setImmediate(done));
      assert.deepEqual(await f.store.call('attempt',{id:f.attempt.id}),saved);
      assert.equal((await f.store.call('reports',{attemptId:f.attempt.id})).length,1);
    }finally{await resumed.close();}
  }finally{late.resolve({});await service.close();await f.close();}
});

test('illegal human choices remain editable and invalid opponent output is recoverable rather than persisted',async()=>{
  const f=await setup();const fallback=offlineDecisions(f.rules);
  const service=new AttemptService(f.store,{decide:async()=>({}),recover:fallback.recover},f.rules);
  try{
    await assert.rejects(service.submit({...f.input,action:{phase:'ORDERS',orderIds:['ANK|MOVE|PAR']}}),{code:'STORE_INVALID'});
    assert.equal((await f.store.call('attempt',{id:f.attempt.id}))!.revision,0);
    assert.equal(await f.store.call('receipt',{attemptId:f.attempt.id,playerId:f.player.id,requestId:f.input.requestId}),null);
    await service.submit(f.input);await service.wait(f.attempt.id);
    assert.equal((await f.store.call('pendingPhaseJobs',{}))[0].decisions,null);
    await service.recover();assert.equal((await f.store.call('attempt',{id:f.attempt.id}))!.board.season,'FALL');
  }finally{await service.close();await f.close();}
});

for(const stage of ['intent','decisions','resolved','committed'])test(`SIGKILL after ${stage} recovers exactly one report and durable duplicate receipt`,async()=>{
  const f=await setup();await f.store.close();
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/crashPhase.js',import.meta.url)),f.path,stage],{env:{PATH:process.env.PATH},stdio:'ignore'});
  const timer=setTimeout(()=>child.kill('SIGTERM'),10000);
  try{
    const [code,signal]=await once(child,'exit');clearTimeout(timer);assert.equal(code,null);assert.equal(signal,'SIGKILL');
    await f.reopen();
    let calls=0;
    const service=new AttemptService(f.store,{decide:async()=>{throw Error('Recovery must not dispatch a new operation');},recover:async ctx=>{calls++;return f.rules.defaults(ctx.job,ctx.signal);}},f.rules);
    try{
      await service.recover();await service.recover();
      assert.equal(calls,stage==='intent'?1:0,'persisted decisions are reused without another provider call');
      const saved=(await f.store.call('attempt',{id:f.attempt.id}))!;
      assert.equal(saved.board.season,'FALL');assert.equal(saved.execution,'ACCEPTING');
      const reports=await f.store.call('reports',{attemptId:f.attempt.id});assert.equal(reports.length,1);
      const duplicate=await service.submit({...f.input,requestId:'crash-request'});assert.equal(duplicate.state.status,'ACCEPTED');
      assert.equal((await f.store.call('reports',{attemptId:f.attempt.id})).length,1);
    }finally{await service.close();}
  }finally{clearTimeout(timer);child.kill();await f.close();}
});


test('committed objective and achievement survive four durable phase advances and a restart',async()=>{
  const f=await setup();const witness=f.fixture.witnesses.find(w=>w.name==='early-capture')!;
  const choices=async(job:PhaseJob,signal:AbortSignal)=>{
    const step=witness.steps.find(s=>s.year===job.board.year && s.season===job.board.season && s.phase===job.board.phase)!;
    assert.equal(step.phase,'ORDERS');if(step.phase!=='ORDERS')throw Error('fixture');
    const result:PhaseDecisions={};
    for(const power of ALL_POWERS){
      const legal=await f.rules.legal(job.board,power,signal);
      const selected=step.orders.map(id=>legal.find(o=>o.id===id)).filter(o=>o!==undefined);
      result[power]={phase:'ORDERS',orderIds:legal.filter(o=>o.order.type==='HOLD' && !selected.some(s=>s.unitTerritory===o.unitTerritory)).concat(selected).map(o=>o.id)};
    }
    return result;
  };
  const decide:DecisionProvider['decide']=async({job,signal})=>{const result=await choices(job,signal);delete result[job.definition.humanPower];return result;};
  const service=new AttemptService(f.store,{decide,recover:decide},f.rules);
  try{
    let saved=f.attempt;
    for(let i=0;i<witness.steps.length;i++){
      const definition=(await f.store.call('challenge',{id:saved.challengeId,version:saved.challengeVersion}))!.definition;
      const chosen=await choices({...saved,attemptId:saved.id,operationId:'choices',status:'DECIDING',definition,requestId:'choices',humanAction:f.input.action,decisions:null,reportOffset:i} as PhaseJob,new AbortController().signal);
      await service.submit({...f.input,revision:saved.revision,phaseId:saved.phaseId,requestId:`step-${i}`,action:chosen[definition.humanPower]});
      await service.wait(saved.id);saved=(await f.store.call('attempt',{id:saved.id}))!;
      assert.equal((await f.store.call('reports',{attemptId:saved.id})).length,i+1);
    }
    assert.equal(saved.lifecycle,'COMPLETED');assert.equal(saved.score?.outcome,'SUCCESS');assert.deepEqual(saved.score?.achievementIds,['EARLY_CAPTURE']);
    await service.close();await f.reopen();assert.deepEqual(await f.store.call('attempt',{id:saved.id}),saved);
  }finally{await service.close();await f.close();}
});

for(const name of ['retreat-position','winter-build'])test(`durable ${name} phase preserves imported board context`,async()=>{
  const f=await setup(name);const service=new AttemptService(f.store,offlineDecisions(f.rules),f.rules);
  try{
    const step=f.fixture.witnesses[0].steps[0];
    const action=step.phase==='RETREATS'?{phase:step.phase,retreats:step.retreats}:step.phase==='BUILDS'?{phase:step.phase,...step.adjustments.FRANCE!}:null;
    assert.ok(action);
    await service.submit({...f.input,action});await service.wait(f.attempt.id);
    const saved=(await f.store.call('attempt',{id:f.attempt.id}))!;
    assert.equal(saved.execution,'ACCEPTING');assert.equal(saved.board.phase,'ORDERS');
    const reports=await f.store.call('reports',{attemptId:f.attempt.id});assert.equal(reports.length,1);assert.equal(reports[0].phase,step.phase);
    await service.close();await f.reopen();assert.deepEqual(await f.store.call('attempt',{id:saved.id}),saved);
  }finally{await service.close();await f.close();}
});

test('concurrent recovery fences an older worker without returning accepted orders to editing',async()=>{
  const f=await setup(),started=deferred<PhaseJob>(),late=deferred<PhaseDecisions>();
  const original=new AttemptService(f.store,{decide:async({job})=>{started.resolve(job);return late.promise;},recover:offlineDecisions(f.rules).recover},f.rules);
  const replacement=new AttemptService(f.store,offlineDecisions(f.rules),f.rules);
  try{
    await original.submit(f.input);const old=await started.promise;
    await replacement.recover();const saved=await f.store.call('attempt',{id:f.attempt.id});
    assert.equal(saved!.board.season,'FALL');
    late.resolve(await f.rules.defaults(old,new AbortController().signal));await original.wait(f.attempt.id);
    assert.deepEqual(await f.store.call('attempt',{id:f.attempt.id}),saved);
    assert.equal((await f.store.call('reports',{attemptId:f.attempt.id})).length,1);
  }finally{late.resolve({});await original.close();await replacement.close();await f.close();}
});

test('phase commit rolls all writes back on invalid report output and preserves reusable saved decisions',async()=>{
  const f=await setup();let captured:PhaseJob|undefined;
  const service=new AttemptService(f.store,offlineDecisions(f.rules),f.rules,{boundary:async(stage,job)=>{if(stage==='resolved'){captured=job;throw Error('simulated interruption');}}});
  try{
    await service.submit(f.input);await service.wait(f.attempt.id);assert.ok(captured);
    const job=(await f.store.call('pendingPhaseJobs',{}))[0];
    const result=await f.rules.resolve(job,new AbortController().signal);
    const invalid=structuredClone(result);invalid.board.units.pop();
    await assert.rejects(f.store.call('commitPhase',{fence:job,...invalid,now}),{code:'STORE_CONFLICT'});
    assert.equal((await f.store.call('reports',{attemptId:job.attemptId})).length,0);
    assert.equal((await f.store.call('receipt',{attemptId:job.attemptId,playerId:job.playerId,requestId:job.requestId}))!.state.status,'SUBMITTING');
    const committed=await f.store.call('commitPhase',{fence:job,...result,now});
    assert.deepEqual(await f.store.call('commitPhase',{fence:job,...result,now}),committed);
    assert.equal((await f.store.call('reports',{attemptId:job.attemptId})).length,1);
  }finally{await service.close();await f.close();}
});

test('provider rejection records a safe recovery message and cannot leak its error details',async()=>{
  const f=await setup(),fallback=offlineDecisions(f.rules);
  const service=new AttemptService(f.store,{decide:async()=>{throw Error('synthetic-private-provider-body');},recover:fallback.recover},f.rules);
  try{
    await service.submit(f.input);await service.wait(f.attempt.id);
    const receipt=await service.submit(f.input);
    assert.equal(receipt.state.error?.code,'RECOVERY_REQUIRED');assert.ok(!JSON.stringify(receipt).includes('synthetic-private'));
    await service.recover();assert.equal((await f.store.call('attempt',{id:f.attempt.id}))!.board.season,'FALL');
  }finally{await service.close();await f.close();}
});

test('simultaneous validations respect worker capacity and shutdown cannot accept a pending command',async()=>{
  const f=await setup(),started=deferred<void>(),release=deferred<void>();
  class SlowRules extends PhaseRules {
    override async validate(...args:Parameters<PhaseRules['validate']>) {started.resolve();await release.promise;args[3].throwIfAborted();}
  }
  const rules=new SlowRules();const service=new AttemptService(f.store,offlineDecisions(rules),rules,{maxRunning:1});
  try{
    const first=service.submit(f.input);const rejected=assert.rejects(first);
    await started.promise;
    await assert.rejects(service.submit({...f.input,requestId:'other'}),{code:'STORE_BUSY'});
    const closing=service.close();release.resolve();await rejected;await closing;
    assert.equal((await f.store.call('attempt',{id:f.attempt.id}))!.execution,'ACCEPTING');
    assert.equal((await f.store.call('pendingPhaseJobs',{})).length,0);
  }finally{release.resolve();await service.close();await f.close();}
});
