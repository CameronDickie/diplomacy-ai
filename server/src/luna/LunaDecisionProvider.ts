import type { Power } from '@diplomacy/shared';
import type { DecisionContext, DecisionProvider } from '../attempts/AttemptService.js';
import type { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseAction, PhaseDecisions } from '../attempts/types.js';
import type { Store } from '../storage/Store.js';
import { StoreError } from '../storage/contracts.js';
import type { ProviderCallIntent, ProviderCallRecord } from '../providers/accounting.js';
import { LUNA_PRESET } from '../providers/LunaPreset.js';
import { normalizeLunaResponse } from '../providers/LunaResponse.js';
import { ProviderCallError, recordedCall } from '../providers/RecordedCall.js';
import { forcedAction, parseChoices } from './Choices.js';
import { lunaPrompt } from './Context.js';
import type { LunaTransport } from './Transport.js';

export type LunaFailure = 'BUDGET_EXHAUSTED' | 'ATTEMPT_BUDGET_EXHAUSTED' | 'PAUSED_OR_CLOSED' | 'CALL_LIMIT' | 'PROVIDER';
/** Why a sponsored phase could not be decided. The phase is left recoverable; opponents are never swapped for holds. */
export class LunaDecisionError extends Error {
  constructor(readonly code: LunaFailure, readonly power: Power) { super(`Sponsored decision unavailable (${code}).`); this.name = 'LunaDecisionError'; }
}
interface Options {
  now?: () => number;
  /** Total provider calls one power may consume for one phase, across every recovery. */
  maxCallsPerPower?: number;
  timeoutMs?: number;
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
  constructor(private store: Store, private rules: PhaseRules, private transport: LunaTransport, private options: Options = {}) { this.now = options.now ?? Date.now; }
  decide(context: DecisionContext): Promise<PhaseDecisions> { return this.run(context); }
  recover(context: DecisionContext): Promise<PhaseDecisions> { return this.run(context); }

  private async run({ job, signal }: DecisionContext): Promise<PhaseDecisions> {
    const reports = await this.store.call('reports',{ attemptId: job.attemptId }), last = reports.at(-1) ?? null;
    const saved = new Map((await this.store.call('providerDecisions',{ operationId: job.operationId })).map(d => [d.power,d]));
    const calls = await this.store.call('providerCallsForOperation',{ operationId: job.operationId });
    // Every earlier answer is settled or held before anything new is reserved: that is the reconciliation.
    const decisions: PhaseDecisions = {};
    // Sequential on purpose: each reservation sees the previous call's settled cost, and one failure stops spending.
    for (const power of job.definition.opponentPowers) {
      signal.throwIfAborted();
      const legal = job.board.phase === 'ORDERS' ? await this.rules.legal(job.board,power,signal) : [];
      const prompt = lunaPrompt(job,power,legal,last);
      if (!prompt) { decisions[power] = forcedAction(job.board); continue; }
      const kept = saved.get(power);
      if (kept) {
        // Paid for and validated before an interruption. Close its call record if the crash came first.
        await this.store.call('finishProviderCall',{ id: kept.callId, outcome: 'VALID', now: this.now() }).catch(() => {});
        decisions[power] = kept.action; continue;
      }
      decisions[power] = await this.ask(job,power,prompt,calls.filter(c => c.power === power),signal);
    }
    return decisions;
  }

  private async ask(job: DecisionContext['job'], power: Power, prompt: NonNullable<ReturnType<typeof lunaPrompt>>, earlier: ProviderCallRecord[], signal: AbortSignal): Promise<PhaseAction> {
    const fail = (code: LunaFailure): never => { throw new LunaDecisionError(code,power); };
    let callId: string | undefined;
    for (const call of earlier.filter(c => c.state === 'PREPARED')) {
      // Never dispatched. Usable only if it reserved exactly this request under the current fence.
      if (!callId && call.requestHash === prompt.request.requestHash && call.fence.revision === job.revision) callId = call.id;
      else await this.store.call('releaseProviderCall',{ id: call.id, now: this.now() }).catch(() => {});
    }
    // A call left DISPATCHED belongs to a run that no longer exists. Its outcome is unknown, so it is
    // closed as such and its reservation stays held; it is never sent again.
    for (const call of earlier.filter(c => c.state === 'DISPATCHED'))
      await this.store.call('finishProviderCall',{ id: call.id, outcome: 'TRANSPORT_ERROR', now: this.now() }).catch(() => {});
    if (!callId) {
      const used = earlier.filter(c => c.state !== 'PREPARED').length;
      if (used >= (this.options.maxCallsPerPower ?? 3)) fail('CALL_LIMIT');
      const intent: ProviderCallIntent = { id: `${job.operationId}:${power}:${earlier.length + 1}`,
        fence: { operationId: job.operationId, attemptId: job.attemptId, phaseId: job.phaseId, revision: job.revision }, power, provider: 'OPENAI', model: LUNA_PRESET.model,
        role: job.board.phase, pricingVersion: prompt.request.pricingVersion, requestHash: prompt.request.requestHash, maxCostNanousd: prompt.maxCostNanousd };
      try { await this.store.call('prepareProviderCall',{ intent, now: this.now() }); }
      catch (error) {
        const code = error instanceof StoreError ? error.code : null;
        // A conflict here means paid play is stopped, or the attempt, phase or player is no longer current.
        fail(code === 'BUDGET_EXHAUSTED' || code === 'ATTEMPT_BUDGET_EXHAUSTED' ? code : code === 'STORE_CONFLICT' ? 'PAUSED_OR_CLOSED' : 'PROVIDER');
      }
      callId = intent.id;
    }
    const id = callId!;
    await this.options.boundary?.('reserved',power,id);
    try {
      return await recordedCall({ store: this.store, id, signal, timeoutMs: this.options.timeoutMs ?? LUNA_PRESET.timeoutMs, now: this.now,
        transport: async s => { const response = await this.transport({ body: prompt.request.body, signal: s }); return normalizeLunaResponse(response.body,response.status); },
        validate: async parsed => {
          const action = prompt.set.toAction(parseChoices(parsed));
          await this.rules.validate(job.board,power,action,signal);
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
