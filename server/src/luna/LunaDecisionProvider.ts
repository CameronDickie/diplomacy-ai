import type { Power } from '@diplomacy/shared';
import type { DecisionContext, DecisionProvider } from '../attempts/AttemptService.js';
import type { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseAction, PhaseDecisions } from '../attempts/types.js';
import type { Store } from '../storage/Store.js';
import { StoreError } from '../storage/contracts.js';
import type { ProviderCallIntent, ProviderCallRecord } from '../providers/accounting.js';
import { LUNA_CONTRACT, type OpponentContract } from '../providers/OpponentContract.js';
import { singlePlan, type OpponentPlan } from '../providers/OpponentPlan.js';
import { ProviderCallError, recordedCall } from '../providers/RecordedCall.js';
import { forcedAction, parseChoices } from './Choices.js';
import { lunaPrompt } from './Context.js';
import type { LunaTransport } from './Transport.js';

export type LunaFailure = 'BUDGET_EXHAUSTED' | 'ATTEMPT_BUDGET_EXHAUSTED' | 'PAUSED_OR_CLOSED' | 'CALL_LIMIT' | 'PREFLIGHT' | 'PROVIDER' | 'PRESET_MISMATCH';
/** Why a sponsored phase could not be decided. The phase is left recoverable; opponents are never swapped for holds. */
export class LunaDecisionError extends Error {
  constructor(readonly code: LunaFailure, readonly power: Power) { super(`Sponsored decision unavailable (${code}).`); this.name = 'LunaDecisionError'; }
}
interface Options {
  now?: () => number;
  /** Which pinned preset to serve. Defaults to Luna. */
  contract?: OpponentContract;
  /** Per-power presets for a development playtest. Takes precedence over `contract`. */
  plan?: OpponentPlan;
  /** A transport per preset, for a plan that uses more than one. Presets not named use the main transport. */
  transports?: Partial<Record<OpponentContract['key'], LunaTransport>>;
  /** Total provider calls one power may consume for one phase, across every recovery. */
  maxCallsPerPower?: number;
  timeoutMs?: number;
  /** Test seam for narrower workers; production always uses the pinned server preset. */
  maxConcurrentDecisions?: number;
  /** Test seam: awaited at named points for one power, to inject crashes and stops. */
  boundary?: (stage: 'reserved' | 'decided', power: Power, callId: string) => Promise<void>;
}

/**
 * Opponent decisions from the server-owned Luna preset, through the ledger and the durable call
 * records. `decide` and `recover` are the same procedure: reconcile what already exists for this
 * phase, reuse every decision already paid for, and only then reserve anything new. One run makes
 * at most one new call per power (the preset has no automatic retries); a later explicit recovery
 * is a new reserved call, up to `maxCallsPerPower`.
 */
export class LunaDecisionProvider implements DecisionProvider {
  private readonly now: () => number;
  /** What this provider serves; an attempt pinned to anything else is refused before any call. */
  private readonly plan: OpponentPlan;
  constructor(private store: Store, private rules: PhaseRules, private transport: LunaTransport, private options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.plan = options.plan ?? singlePlan(options.contract ?? LUNA_CONTRACT);
    const width=options.maxConcurrentDecisions ?? this.plan.maxConcurrentDecisions;
    if(!Number.isSafeInteger(width)||width<1||width>this.plan.maxConcurrentDecisions)throw new Error('Invalid opponent concurrency.');
  }
  decide(context: DecisionContext): Promise<PhaseDecisions> { return this.run(context); }
  recover(context: DecisionContext): Promise<PhaseDecisions> { return this.run(context); }

  private async run({ job, signal }: DecisionContext): Promise<PhaseDecisions> {
    signal.throwIfAborted();
    const attempt=await this.store.call('attempt',{id:job.attemptId,playerId:job.playerId});
    if(!attempt)throw new LunaDecisionError('PAUSED_OR_CLOSED',job.definition.opponentPowers[0]);
    if(attempt.preset&&(attempt.preset.id!==this.plan.id||attempt.preset.pricingVersion!==this.plan.pricingVersion))
      throw new LunaDecisionError('PRESET_MISMATCH',job.definition.opponentPowers[0]);
    const reports = await this.store.call('reports',{ attemptId: job.attemptId }), last = reports.at(-1) ?? null;
    const saved = new Map((await this.store.call('providerDecisions',{ operationId: job.operationId })).map(d => [d.power,d]));
    const calls = await this.store.call('providerCallsForOperation',{ operationId: job.operationId });
    // Every earlier answer is settled or held before anything new is reserved: that is the reconciliation.
    const decisions: PhaseDecisions = {};
    // Reconcile everything left by an earlier run before any worker reserves: a hold from an older fence
    // is released, and a call that was dispatched by a run that no longer exists is closed as unknown.
    for (const call of calls) {
      if (call.state === 'PREPARED' && call.fence.revision !== job.revision) await this.releaseUnsent(call.id);
      else if (call.state === 'DISPATCHED') await this.store.call('finishProviderCall',{ id: call.id, outcome: 'TRANSPORT_ERROR', now: this.now() }).catch(() => {});
    }
    // `waiting` holds the tasks parked on a sibling: two parked tasks must never wait on each other.
    const inFlight = new Set<Promise<unknown>>(), waiting = new Set<Promise<unknown>>();
    let next = 0, failed = false, failure: unknown;
    const worker = async () => {
      // A failure stops new calls from starting. Calls already in flight are paid for either way, so they
      // finish and their answers are saved for the recovery; only the outer signal cancels them.
      while (!failed && !signal.aborted && next < job.definition.opponentPowers.length) {
        const power = job.definition.opponentPowers[next++];
        try {
          const legal = job.board.phase === 'ORDERS' ? await this.rules.legal(job.board,power,signal) : [];
          signal.throwIfAborted();
          const prompt = lunaPrompt(job,power,legal,last,this.plan.contractFor(power));
          if (!prompt) { decisions[power] = forcedAction(job.board); continue; }
          const kept = saved.get(power);
          if (kept) {
            // Reuse the validated answer; a crash may have preceded finishing its call record.
            await this.store.call('finishProviderCall',{ id: kept.callId, outcome: 'VALID', now: this.now() }).catch(() => {});
            decisions[power] = kept.action; continue;
          }
          if (failed) break;
          const slot: { task?: Promise<PhaseAction> } = {};
          // Resolves once another power's call has finished, or false when nothing else is in flight.
          const sibling = async (): Promise<boolean> => {
            const others = [...inFlight].filter(p => p !== slot.task && !waiting.has(p));
            if (!others.length || !slot.task) return false;
            waiting.add(slot.task);
            try { await Promise.race(others.map(p => p.then(() => {},() => {}))); } finally { waiting.delete(slot.task); }
            return true;
          };
          slot.task = this.ask(job,power,prompt,calls.filter(c => c.power === power),signal,sibling,() => failed);
          inFlight.add(slot.task);
          try { decisions[power] = await slot.task; } finally { inFlight.delete(slot.task); }
        } catch (error) {
          if (!failed) { failed = true; failure = error; }
        }
      }
    };
    // Transactions serialize funding admission even while requests overlap. Every worker's accounted
    // outcome is awaited; late provider receipts can still settle bills but cannot save stale actions.
    await Promise.all(Array.from({ length: this.options.maxConcurrentDecisions ?? this.plan.maxConcurrentDecisions },() => worker()));
    if (failed || signal.aborted) {
      const current = await this.store.call('providerCallsForOperation',{ operationId: job.operationId });
      for (const call of current.filter(c => c.state === 'PREPARED' && c.fence.revision === job.revision))
        await this.releaseUnsent(call.id);
      if (failed) throw failure;
      signal.throwIfAborted();
    }
    return decisions;
  }

  /** A newer recovery may already have released this old, never-dispatched hold. */
  private async releaseUnsent(id: string): Promise<void> {
    try { await this.store.call('releaseProviderCall',{id,now:this.now()}); }
    catch(error){
      if(!(error instanceof StoreError)||error.code!=='STORE_CONFLICT')throw error;
      const record=await this.store.call('providerCall',{id});
      if(!record||record.dispatchedAt!==null||record.outcome!=='CANCELLED')throw error;
    }
  }

  private async ask(job: DecisionContext['job'], power: Power, prompt: NonNullable<ReturnType<typeof lunaPrompt>>, earlier: ProviderCallRecord[], signal: AbortSignal,
      sibling: () => Promise<boolean> = async () => false, halted: () => boolean = () => false): Promise<PhaseAction> {
    const fail = (code: LunaFailure): never => { throw new LunaDecisionError(code,power); };
    const contract = this.plan.contractFor(power);
    let callId: string | undefined;
    for (const call of earlier.filter(c => c.state === 'PREPARED')) {
      // Never dispatched. Usable only if it reserved exactly this request under the current fence.
      if (!callId && call.requestHash === prompt.request.requestHash && call.fence.revision === job.revision
        && call.maxCostNanousd === prompt.maxCostNanousd) callId = call.id;
      else await this.store.call('releaseProviderCall',{ id: call.id, now: this.now() }).catch(() => {});
    }
    // A call left DISPATCHED belongs to a run that no longer exists. Its outcome is unknown, so it is
    // closed as such and its reservation stays held; it is never sent again.
    for (const call of earlier.filter(c => c.state === 'DISPATCHED'))
      await this.store.call('finishProviderCall',{ id: call.id, outcome: 'TRANSPORT_ERROR', now: this.now() }).catch(() => {});
    if (!callId) {
      // Only a call that actually left the process uses up the limit. A hold released before dispatch
      // (stale fence, failed token-count preflight) bought nothing and must not strand the phase.
      const used = earlier.filter(c => c.dispatchedAt !== null).length;
      if (used >= (this.options.maxCallsPerPower ?? 3)) fail('CALL_LIMIT');
      const intent: ProviderCallIntent = { id: `${job.operationId}:${power}:${earlier.length + 1}`,
        fence: { operationId: job.operationId, attemptId: job.attemptId, phaseId: job.phaseId, revision: job.revision }, power, provider: contract.preset.provider, model: contract.preset.model,
        role: job.board.phase, pricingVersion: prompt.request.pricingVersion, requestHash: prompt.request.requestHash, maxCostNanousd: prompt.maxCostNanousd };
      for (;;) {
        try { await this.store.call('prepareProviderCall',{ intent, now: this.now() }); break; }
        catch (error) {
          const code = error instanceof StoreError ? error.code : null;
          if (code === 'FUNDS_BUSY') {
            // Sibling calls of this phase are holding their worst case. Wait for one to settle and ask again;
            // the ledger reports real exhaustion (and pauses) only once nothing is in flight.
            if (halted()) fail('PAUSED_OR_CLOSED');
            if (!(await sibling())) fail('BUDGET_EXHAUSTED');
            signal.throwIfAborted();
            continue;
          }
          // A conflict here means paid play is stopped, or the attempt, phase or player is no longer current.
          fail(code === 'BUDGET_EXHAUSTED' || code === 'ATTEMPT_BUDGET_EXHAUSTED' ? code : code === 'STORE_CONFLICT' ? 'PAUSED_OR_CLOSED' : 'PROVIDER');
        }
      }
      callId = intent.id;
    }
    const id = callId!;
    await this.options.boundary?.('reserved',power,id);
    let transport = this.options.transports?.[contract.key] ?? this.transport;
    if (transport.preflight) {
      try { transport = (await transport.preflight({ body: prompt.request.body, signal })).send; }
      catch {
        // No generation sender was obtained: no model response was created and the hold is still PREPARED.
        await this.store.call('releaseProviderCall',{ id, now: this.now() }).catch(() => {});
        fail(signal.aborted ? 'PAUSED_OR_CLOSED' : 'PREFLIGHT');
      }
    }
    try {
      return await recordedCall({ store: this.store, id, signal, timeoutMs: this.options.timeoutMs ?? contract.preset.timeoutMs, now: this.now,
        transport: async s => { const response = await transport({ body: prompt.request.body, signal: s }); return contract.normalizeResponse(response.body,response.status); },
        validate: async (parsed,callSignal) => {
          const action = prompt.set.toAction(parseChoices(parsed));
          await this.rules.validate(job.board,power,action,callSignal);
          callSignal.throwIfAborted();
          // Stored before the call is finished, so an interruption between the two cannot lose a paid answer.
          await this.store.call('saveProviderDecision',{ callId: id, action, now: this.now() });
          await this.options.boundary?.('decided',power,id);
          return action;
        } });
    } catch (error) {
      if (error instanceof LunaDecisionError) throw error;
      // The call's own outcome (invalid, refused, timeout, cancelled…) is already recorded with its billing.
      return fail(error instanceof ProviderCallError && error.outcome === 'CANCELLED' ? 'PAUSED_OR_CLOSED' : 'PROVIDER');
    }
  }
}
