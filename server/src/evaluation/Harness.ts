import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AttemptService } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { challengeDefinition, importScenario, type ScenarioFixture } from '../fixtures/ScenarioFixture.js';
import { CONTEXT_VERSION } from '../luna/Context.js';
import { LunaDecisionProvider } from '../luna/LunaDecisionProvider.js';
import type { LunaTransport } from '../luna/Transport.js';
import { LUNA_PRESET, lunaReservationNanousd } from '../providers/LunaPreset.js';
import type { Store } from '../storage/Store.js';
import { hashToken } from '../storage/Store.js';
import type { EvaluationManifest, EvaluationPhase, StoredAttempt } from '../storage/contracts.js';
import { scriptedHumanAction } from './ScriptedPlayer.js';

/** Launch targets from the release plan. They are reported against, never adjusted to fit a result. */
export const TARGETS = { meanAttemptCostNanousd: 1_000_000_000, phaseP95Ms: 30_000, retryOrFailureRate: 0.05 } as const;
export interface EvaluationOptions {
  store: Store;
  transport: LunaTransport;
  transportKind: 'mock' | 'live';
  runId: string;
  scenario: string;
  scenarioVersion?: number;
  /** Named witness in the scenario fixture that scripts the human's orders; unlisted units hold. */
  script: string;
  attempts: number;
  seed?: number;
  now?: () => number;
  clock?: () => number;
  maxRecoveries?: number;
  log?: (line: string) => void;
  /** Test seam for actual process-kill verification at accepted/committed boundaries. */
  boundary?: (stage:'intent'|'committed',attemptId:string)=>Promise<void>;
}
export interface AttemptResult {
  id: string; outcome: string; lifecycle: string; completedYear: number | null; achievements: readonly string[]; phases: number; stalled: boolean; interrupted: boolean;
  phaseMs: number[]; phaseTimings: EvaluationPhase[]; timingIssues: string[]; recoveries: number; calls: number; callOutcomes: Record<string, number>;
  inputTokens: number; cachedInputTokens: number; outputTokens: number;
  /** Known bills, worst-case holds still outstanding, and the sum of worst-case reservations made. */
  settledNanousd: number; heldNanousd: number; reservedEstimateNanousd: number;
}
export interface EvaluationReport {
  status: 'FINISHED' | 'INTERRUPTED';
  manifest: EvaluationManifest & {attemptsRequested:number};
  attempts: AttemptResult[];
  summary: {
    attempts: number; successes: number; failures: number; stalled: number; phases: number; timedPhases:number; timingIssues:number; calls: number; validCalls: number; legalityRate: number | null;
    retryOrFailureRate: number | null; meanAttemptCostNanousd: number | null; maxAttemptCostNanousd: number | null; phaseP50Ms: number | null; phaseP95Ms: number | null;
    settledNanousd: number; heldNanousd: number; reservedEstimateNanousd: number; inputTokens: number; cachedInputTokens: number; outputTokens: number;
  };
  targets: Array<{ name: string; target: string; measured: string; met: boolean | null }>;
  ledger: { settledBeforeNanousd: number; settledAfterNanousd: number; attributedNanousd: number; reconciles: boolean };
  notes: string[];
}
const percentile = (values: number[], p: number): number | null => values.length ? [...values].sort((a,b) => a - b)[Math.min(values.length - 1,Math.ceil(p * values.length) - 1)] : null;
const usd = (nano: number | null) => nano === null ? 'n/a' : `USD ${(nano / 1e9).toFixed(6)}`;

async function loadScenario(name: string, version: number): Promise<ScenarioFixture> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Unknown scenario.');
  return importScenario(JSON.parse(await readFile(new URL(`../../fixtures/development/${name}.v${version}.json`,import.meta.url),'utf8')));
}

/**
 * Plays sponsored attempts end to end through the same ledger, provider and rules engine the game
 * uses. Safe to re-run with the same run ID: finished attempts are read back, an interrupted one is
 * recovered through the provider's own reconciliation, and nothing already bought is bought again.
 */
export async function evaluate(options: EvaluationOptions): Promise<EvaluationReport> {
  const { store, runId } = options, now = options.now ?? Date.now, clock = options.clock ?? Date.now, log = options.log ?? (() => {});
  if (!/^[a-z0-9-]{3,40}$/.test(runId)) throw new Error('Run ID must be 3–40 lowercase letters, digits or dashes.');
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1 || options.attempts > 200) throw new Error('Attempts must be between 1 and 200.');
  const maxRecoveries = options.maxRecoveries ?? 2, version = options.scenarioVersion ?? 1;
  if(!Number.isSafeInteger(maxRecoveries)||maxRecoveries<0||maxRecoveries>10)throw new Error('Recovery limit must be between 0 and 10.');
  if(options.seed!==undefined&&(!Number.isSafeInteger(options.seed)||options.seed<0||options.seed>0xffffffff))throw new Error('Seed must be an unsigned 32-bit integer.');
  const fixture = await loadScenario(options.scenario,version), definition = challengeDefinition(fixture);
  if (!definition) throw new Error('Scenario has no objective to score.');
  if (!fixture.witnesses.some(w => w.name === options.script)) throw new Error(`Scenario has no script named ${options.script}.`);
  const manifest=await store.call('registerEvaluationRun',{manifest:{runId,transport:options.transportKind,scenario:definition.id,scenarioVersion:definition.version,
    fixtureHash:createHash('sha256').update(canonicalJson(fixture)).digest('hex'),script:options.script,seed:options.seed??null,
    presetId:LUNA_PRESET.id,pricingVersion:LUNA_PRESET.pricingVersion,presetHash:createHash('sha256').update(canonicalJson(LUNA_PRESET)).digest('hex'),
    contextVersion:CONTEXT_VERSION,model:LUNA_PRESET.model,harnessVersion:'luna-evaluation-v3',timingPolicy:'wall-submission-commit-v1',maxRecoveries},now:now()});
  const content = { definition, board: fixture.board };
  await store.call('registerChallenge',{ ...content, hash: createHash('sha256').update(canonicalJson(content)).digest('hex'), now: now() });
  const player = await store.call('identity',{ provider: 'github', subject: `evaluation-${runId}`, displayName: 'Evaluation harness', now: now() });
  const rules = new PhaseRules(), settledBefore = (await store.call('fundingTotals',{})).settledNanousd;
  const service = new AttemptService(store,new LunaDecisionProvider(store,rules,options.transport,{ now }),rules,{ now, maxRunning: 1,measurementClock:()=>Math.round(clock()),
    boundary:async(stage,job)=>{if(stage==='intent'||stage==='committed')await options.boundary?.(stage,job.attemptId);} });
  const results: AttemptResult[] = [], notes: string[] = [];
  let preexisting = 0, interrupted = false;
  try {
    for (let n = 1; n <= options.attempts; n++) {
      const id = `eval-${runId}-${n}`;
      let attempt = await store.call('attempt',{ id });
      let stalled = false;
      if (attempt) preexisting += (await store.call('attemptFunding',{ attemptId: id })).settledNanousd;
      try {
        // Mapping and attempt creation are atomic; an expired mapping can never buy the attempt again.
        attempt = await store.call('createEvaluationAttempt',{runId,ordinal:n,playerId:player.id,reconnectTokenHash:hashToken(id),now:now(),
          sponsored:{preset:{id:LUNA_PRESET.id,pricingVersion:LUNA_PRESET.pricingVersion},minimumAvailableNanousd:lunaReservationNanousd(LUNA_PRESET.maxInputTokens)}});
      } catch (error) {
        if((error as {code?:string}).code==='STORE_CONFLICT')throw error;
        notes.push(`Stopped before attempt ${n}: ${(error as { code?: string }).code ?? 'start refused'}. Sponsored play is paused or unfunded.`);break;
      }
      try {
        for (let guard = 0; attempt!.lifecycle === 'ACTIVE' && guard < 120; guard++) {
          const before: StoredAttempt = attempt!;
          if (before.execution === 'ACCEPTING') {
            const action = await scriptedHumanAction(rules,before.board,definition.humanPower,fixture,options.script);
            await service.submit({ attemptId: id, playerId: player.id, revision: before.revision, phaseId: before.phaseId, requestId: `eval-${before.revision}`, action });
          } else {
            // Interrupted earlier, or an opponent decision failed: an explicit, counted recovery.
            const phase=(await store.call('evaluationPhases',{attemptId:id})).find(p=>p.phaseId===before.phaseId);
            if(!phase||phase.recoveries>=maxRecoveries){stalled=true;break;}
            await service.recover(id);
          }
          await service.wait(id);
          attempt = (await store.call('attempt',{ id }))!;
          // Timing and recovery counts are already committed with the phase, even if this process dies here.
        }
      } catch {
        // Never echo local/provider errors: they may contain credentials or private request content.
        interrupted = true;
        notes.push(`Local evaluation interrupted at attempt ${n}; its saved state remains resumable. No later attempt was started.`);
        await service.close();
        attempt = (await store.call('attempt',{ id }))!;
      }
      if (!interrupted && attempt!.lifecycle === 'ACTIVE') {
        // Close it so the run leaves no live attempt behind; its costs stay on the ledger.
        stalled = true;
        attempt = await service.terminate(id,player.id,'STOPPED');
      }
      stalled ||= attempt!.lifecycle !== 'COMPLETED';
      const reports=await store.call('reports',{attemptId:id}),phaseTimings=await store.call('evaluationPhases',{attemptId:id});
      const completed=phaseTimings.filter(p=>p.completedAt!==null),phaseMs=completed.flatMap(p=>p.durationMs===null?[]:[p.durationMs]);
      const timingIssues:string[]=[];
      if(reports.some(r=>!completed.some(p=>p.operationId===r.id&&p.sequence===r.sequence))||completed.length!==reports.length)timingIssues.push('Committed reports do not match phase timing evidence.');
      if(completed.some(p=>p.durationMs===null))timingIssues.push('Wall clock moved backwards; latency is unavailable for that phase.');
      const recoveries=phaseTimings.reduce((sum,p)=>sum+p.recoveries,0);
      const calls = await callsFor(store,id), funding = await store.call('attemptFunding',{ attemptId: id }), score = attempt!.score;
      const result: AttemptResult = { id, outcome: score?.outcome ?? 'INCOMPLETE', lifecycle: attempt!.lifecycle, completedYear: score?.completedYear ?? null, achievements: score?.achievementIds ?? [],
        phases: reports.length, stalled, interrupted, phaseMs, phaseTimings, timingIssues, recoveries, calls: calls.length,
        callOutcomes: calls.reduce<Record<string,number>>((all,c) => { const key = c.outcome ?? `UNFINISHED_${c.state}`; all[key] = (all[key] ?? 0) + 1; return all; },{}),
        inputTokens: calls.reduce((s,c) => s + (c.usage?.inputTokens ?? 0),0), cachedInputTokens: calls.reduce((s,c) => s + (c.usage?.cachedInputTokens ?? 0),0),
        outputTokens: calls.reduce((s,c) => s + (c.usage?.outputTokens ?? 0),0),
        settledNanousd: funding.settledNanousd, heldNanousd: funding.heldNanousd, reservedEstimateNanousd: calls.reduce((s,c) => s + c.maxCostNanousd,0) };
      results.push(result);
      log(`${id}: ${result.outcome}${result.stalled ? ' (stalled)' : ''} · ${result.phases} phases · ${result.calls} calls · ${usd(result.settledNanousd)} settled, ${usd(result.heldNanousd)} held`);
      if (interrupted) break;
      if (stalled && (await store.call('paidState',{})).stopped) { notes.push(`Stopped after attempt ${n}: sponsored play is paused.`); break; }
    }
  } finally { await service.close(); }
  const settledAfter = (await store.call('fundingTotals',{})).settledNanousd, phases = results.flatMap(r => r.phaseMs), calls = results.reduce((s,r) => s + r.calls,0);
  const valid = results.reduce((s,r) => s + (r.callOutcomes.VALID ?? 0),0), sum = (pick: (r: AttemptResult) => number) => results.reduce((s,r) => s + pick(r),0);
  const incomplete = results.some(r => r.lifecycle !== 'COMPLETED');
  const mean = results.length && !incomplete ? Math.round(sum(r => r.settledNanousd + r.heldNanousd) / results.length) : null;
  const retryRate = calls ? (calls - valid) / calls : null, p95 = percentile(phases,0.95);
  const attributed = sum(r => r.settledNanousd) - preexisting, timingIssues=sum(r=>r.timingIssues.length);
  if(incomplete)notes.push('An attempt did not complete: full-attempt cost is unavailable and passing latency/quality targets remain inconclusive. Observed misses are retained.');
  if(timingIssues)notes.push('Latency evidence is incomplete or the clock regressed; the latency target cannot be declared met.');
  if (options.transportKind === 'mock') notes.push('Mock transport: token counts, latency and cost come from a local stand-in and say nothing about the real model. Only the plumbing, legality handling and accounting are exercised.');
  if (results.length < 30) notes.push(`Sample of ${results.length} attempt${results.length === 1 ? '' : 's'}: too small for rates or percentiles to be more than indicative.`);
  return {
    status: interrupted ? 'INTERRUPTED' : 'FINISHED',
    manifest: {...manifest,attemptsRequested:options.attempts},
    attempts: results,
    summary: { attempts: results.length, successes: results.filter(r => r.outcome === 'SUCCESS').length, failures: results.filter(r => r.outcome === 'FAILURE').length, stalled: results.filter(r => r.stalled).length,
      phases: sum(r=>r.phases), timedPhases:phases.length, timingIssues, calls, validCalls: valid, legalityRate: calls ? valid / calls : null, retryOrFailureRate: retryRate, meanAttemptCostNanousd: mean,
      maxAttemptCostNanousd: results.length ? Math.max(...results.map(r => r.settledNanousd + r.heldNanousd)) : null, phaseP50Ms: percentile(phases,0.5), phaseP95Ms: p95,
      settledNanousd: sum(r => r.settledNanousd), heldNanousd: sum(r => r.heldNanousd), reservedEstimateNanousd: sum(r => r.reservedEstimateNanousd),
      inputTokens: sum(r => r.inputTokens), cachedInputTokens: sum(r => r.cachedInputTokens), outputTokens: sum(r => r.outputTokens) },
    // Cost counts held liability as spent: an unanswered call may still be billed.
    targets: [
      { name: 'Mean attempt cost (settled + held)', target: `< ${usd(TARGETS.meanAttemptCostNanousd)}`, measured: usd(mean), met: mean === null ? null : mean < TARGETS.meanAttemptCostNanousd },
      { name: 'Phase latency p95', target: `< ${TARGETS.phaseP95Ms} ms`, measured: p95 === null ? 'n/a' : `${p95} ms`, met: p95 === null || timingIssues ? null : p95 >= TARGETS.phaseP95Ms ? false : incomplete ? null : true },
      { name: 'Calls that were not a valid decision', target: `< ${TARGETS.retryOrFailureRate * 100}%`, measured: retryRate === null ? 'n/a' : `${(retryRate * 100).toFixed(1)}%`, met: retryRate === null ? null : retryRate >= TARGETS.retryOrFailureRate ? false : incomplete ? null : true },
    ],
    ledger: { settledBeforeNanousd: settledBefore, settledAfterNanousd: settledAfter, attributedNanousd: attributed, reconciles: settledAfter - settledBefore === attributed },
    notes,
  };
}
const callsFor = (store: Store, attemptId: string) => store.call('providerCallsForAttempt',{ attemptId });
