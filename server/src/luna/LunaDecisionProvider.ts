import { ALL_POWERS } from '@diplomacy/shared';
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
import { ChoiceError, forcedAction } from './Choices.js';
import { lunaPrompt, parseMessages, talkPrompt, type PowerMessage } from './Context.js';
import type { StoredPowerTalk } from '../storage/talks.js';
import { PreflightError, type LunaTransport } from './Transport.js';

export type LunaFailure = 'BUDGET_EXHAUSTED' | 'ATTEMPT_BUDGET_EXHAUSTED' | 'PAUSED_OR_CLOSED' | 'CALL_LIMIT' | 'PREFLIGHT' | 'PROVIDER' | 'PRESET_MISMATCH';
/** Why a sponsored phase could not be decided. The phase is left recoverable; opponents are never swapped for holds. */
export class LunaDecisionError extends Error {
  /** `detail` narrows a PREFLIGHT failure to a loggable category, such as an HTTP status. */
  constructor(readonly code: LunaFailure, readonly power: Power, readonly detail?: string) { super(`Sponsored decision unavailable (${code}).`); this.name = 'LunaDecisionError'; }
}
export interface TalkFailure { phaseId: string; power: Power; round: 'ASK' | 'REPLY'; attempt: number;
  /** The recorded outcome of the call (INVALID_JSON, TIMEOUT, PROVIDER_ERROR…), or PREFLIGHT when the token count failed and nothing was sent. */
  reason: string; final: boolean }
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
  /**
   * Development only, and only for a model-only full game: before each orders phase every power may
   * write to up to this many other powers, and each power written to answers once.
   */
  talk?: { maxRecipients: number;
    /** Further tries for a message call that failed, before that power stays silent this turn. Default 2. */
    retries?: number;
    /** Told about every message call that failed, and whether the power has now given up for the turn. */
    onFailure?: (failure: TalkFailure) => void };
  /**
   * Development diagnostics: told why a billed orders answer could not be used. The reason describes
   * the shape of the mistake (how many numbers, which units were missed or given two); the answer
   * itself is not kept.
   */
  onRejectedDecision?: (rejection: { phaseId: string; power: Power; attempt: number; reason: string }) => void;
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
  /** Why a power's last orders answer for a phase was rejected, by operation and power. Lost on restart, when a general reminder is used instead. */
  private readonly rejections = new Map<string, string>();
  constructor(private store: Store, private rules: PhaseRules, private transport: LunaTransport, private options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.plan = options.plan ?? singlePlan(options.contract ?? LUNA_CONTRACT);
    const width=options.maxConcurrentDecisions ?? this.plan.maxConcurrentDecisions;
    if(!Number.isSafeInteger(width)||width<1||width>this.plan.maxConcurrentDecisions)throw new Error('Invalid opponent concurrency.');
    if(options.talk&&(!Number.isSafeInteger(options.talk.maxRecipients)||options.talk.maxRecipients<1||options.talk.maxRecipients>6))throw new Error('Powers may write to between 1 and 6 others.');
    if(options.talk?.retries!==undefined&&(!Number.isSafeInteger(options.talk.retries)||options.talk.retries<0||options.talk.retries>3))throw new Error('A message call may be retried between 0 and 3 times.');
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
    // Each opponent sees only its own conversation with the player, never another power's.
    const talk = await this.store.call('chatMessages',{ attemptId: job.attemptId });
    // Every power's legal orders, from the public board only, asked for once per phase. They tell each
    // opponent where another power could arrive, which decides whether a support has any purpose.
    const legalByPower = new Map<Power, Promise<Awaited<ReturnType<PhaseRules['legal']>>>>();
    const legalOf = (power: Power) => {
      let legal = legalByPower.get(power);
      if (!legal) legalByPower.set(power,legal = job.board.phase === 'ORDERS' ? this.rules.legal(job.board,power,signal) : Promise.resolve([]));
      return legal;
    };
    const contestedFor = async (power: Power): Promise<Set<string>> => {
      const contested = new Set(job.board.units.filter(u => u.power !== power).map(u => u.territory));
      for (const other of ALL_POWERS) if (other !== power) for (const option of await legalOf(other))
        if (option.order.type === 'MOVE' && option.order.targetTerritory) contested.add(option.order.targetTerritory.split('/')[0]);
      return contested;
    };
    const lanes = this.lanes(signal);
    // Left behind by a failed or cancelled run: holds for calls that never left the process are released.
    const settle = async () => {
      if (!lanes.state.failed && !signal.aborted) return;
      const current = await this.store.call('providerCallsForOperation',{ operationId: job.operationId });
      for (const call of current.filter(c => c.state === 'PREPARED' && c.fence.revision === job.revision))
        await this.releaseUnsent(call.id);
      if (lanes.state.failed) throw lanes.state.failure;
      signal.throwIfAborted();
    };
    // A full game's powers write to each other first; what they said is then part of each one's request.
    let full: ((power: Power) => { messages: PowerMessage[]; partners: Power[] }) | undefined;
    if (this.options.talk && job.definition.autoplay) {
      if (job.board.phase === 'ORDERS') { await this.negotiate(job,last,calls,lanes,signal); await settle(); }
      const said = await this.store.call('powerTalks',{ attemptId: job.attemptId });
      const messages = said.flatMap(t => t.messages.map((m): PowerMessage => ({ when: turnOf(t.phaseId), from: t.power, to: m.to, body: m.body })));
      full = power => ({ messages, partners: [...new Set(said.filter(t => t.operationId === job.operationId).flatMap(t => t.power === power ? t.messages.map(m => m.to) : t.messages.some(m => m.to === power) ? [t.power] : []))] });
    }
    await lanes.each(job.definition.opponentPowers,async power => {
      const legal = await legalOf(power), contested = job.board.phase === 'ORDERS' ? await contestedFor(power) : undefined;
      signal.throwIfAborted();
      // A full game's retry tells the model what was wrong with the answer it is replacing.
      const rejected = calls.some(c => c.power === power && c.role === job.board.phase && c.outcome === 'INVALID_ACTION') || this.rejections.has(`${job.operationId}:${power}`);
      const correction = full && rejected ? this.rejections.get(`${job.operationId}:${power}`) ?? (job.board.phase === 'BUILDS' ? 'it did not follow the rule for how many to pick' : 'it did not give exactly one number for each unit: some unit had more than one and another had none') : undefined;
      const prompt = lunaPrompt(job,power,legal,last,this.plan.contractFor(power),contested,talk.filter(m => m.power === power),full ? { ...full(power), correction } : undefined);
      if (!prompt) { decisions[power] = forcedAction(job.board); return; }
      const kept = saved.get(power);
      if (kept) {
        // Reuse the validated answer; a crash may have preceded finishing its call record.
        await this.store.call('finishProviderCall',{ id: kept.callId, outcome: 'VALID', now: this.now() }).catch(() => {});
        decisions[power] = kept.action; return;
      }
      if (lanes.state.failed) return;
      decisions[power] = await lanes.call((sibling,halted) => this.ask(job,power,prompt,calls.filter(c => c.power === power && c.role === job.board.phase),signal,sibling,halted));
    });
    await settle();
    return decisions;
  }

  /**
   * Bounded concurrency shared by every round of one phase. A failure stops new calls from starting;
   * calls already in flight are paid for either way, so they finish and their answers are saved for
   * the recovery. Transactions serialize funding admission even while requests overlap.
   */
  private lanes(signal: AbortSignal) {
    // `waiting` holds the tasks parked on a sibling: two parked tasks must never wait on each other.
    const inFlight = new Set<Promise<unknown>>(), waiting = new Set<Promise<unknown>>();
    const state: { failed: boolean; failure: unknown } = { failed: false, failure: undefined };
    const call = async <T>(start: (sibling: () => Promise<boolean>, halted: () => boolean) => Promise<T>): Promise<T> => {
      const slot: { task?: Promise<T> } = {};
      // Resolves once another power's call has finished, or false when nothing else is in flight.
      const sibling = async (): Promise<boolean> => {
        const others = [...inFlight].filter(p => p !== slot.task && !waiting.has(p));
        if (!others.length || !slot.task) return false;
        waiting.add(slot.task);
        try { await Promise.race(others.map(p => p.then(() => {},() => {}))); } finally { waiting.delete(slot.task); }
        return true;
      };
      slot.task = start(sibling,() => state.failed);
      inFlight.add(slot.task);
      try { return await slot.task; } finally { inFlight.delete(slot.task); }
    };
    const each = async (powers: readonly Power[], task: (power: Power) => Promise<void>): Promise<void> => {
      let next = 0;
      const worker = async () => {
        while (!state.failed && !signal.aborted && next < powers.length) {
          const power = powers[next++];
          try { await task(power); } catch (error) { if (!state.failed) { state.failed = true; state.failure = error; } }
        }
      };
      await Promise.all(Array.from({ length: this.options.maxConcurrentDecisions ?? this.plan.maxConcurrentDecisions },() => worker()));
    };
    return { state, call, each };
  }

  /**
   * The messages of one orders phase: each power with units may write to a few others, then each
   * power that was written to answers once. A call that fails is tried again at once, a bounded
   * number of times across every run of the phase; after that the power says nothing this turn.
   * Each failure is reported with its recorded outcome. Running out of funds or a stop still fails
   * the phase, exactly as for a decision.
   */
  private async negotiate(job: DecisionContext['job'], last: Parameters<typeof talkPrompt>[2], calls: ProviderCallRecord[], lanes: ReturnType<LunaDecisionProvider['lanes']>, signal: AbortSignal): Promise<void> {
    const alive = job.definition.opponentPowers.filter(p => job.board.units.some(u => u.power === p && !u.mustRetreat));
    const round = async (kind: 'ASK' | 'REPLY', powers: readonly Power[], othersOf: (power: Power, said: StoredPowerTalk[]) => Power[]) => {
      const said = await this.store.call('powerTalks',{ attemptId: job.attemptId });
      const history = said.flatMap(t => t.messages.map((m): PowerMessage => ({ when: turnOf(t.phaseId), from: t.power, to: m.to, body: m.body })));
      await lanes.each(powers,async power => {
        const done = said.find(t => t.operationId === job.operationId && t.kind === kind && t.power === power);
        if (done) { await this.store.call('finishProviderCall',{ id: done.callId, outcome: 'VALID', now: this.now() }).catch(() => {}); return; }
        let earlier = calls.filter(c => c.power === power && c.role === kind);
        const others = othersOf(power,said), limit = 1 + (this.options.talk!.retries ?? 2), sentCalls = () => earlier.filter(c => c.dispatchedAt !== null).length;
        if (!others.length) return;
        const contract = this.plan.contractFor(power), prompt = talkPrompt(job,power,last,kind,others,history,this.options.talk!.maxRecipients,contract);
        // Calls that left the process count against the limit across every run of this phase; `tries` also
        // bounds failures that never left it (a token count that failed).
        for (let tries = 0; tries < limit && sentCalls() < limit && !lanes.state.failed; tries++) {
          signal.throwIfAborted();
          try {
            await lanes.call((sibling,halted) => this.call(job,power,{ role: kind, id: n => `${job.operationId}:${power}:${kind.toLowerCase()}:${n}`, limit, request: prompt.request, maxCostNanousd: prompt.maxCostNanousd,
              validate: async (parsed,_signal,id) => { await this.store.call('savePowerTalk',{ callId: id, messages: parseMessages(parsed,prompt.allowed,prompt.max), now: this.now() }); } },earlier,signal,sibling,halted));
            return;
          } catch (error) {
            // Silence is a legitimate result of a negotiation round; lost funds or a stop are not.
            if (!(error instanceof LunaDecisionError) || !['PROVIDER','PREFLIGHT','CALL_LIMIT'].includes(error.code)) throw error;
            earlier = (await this.store.call('providerCallsForOperation',{ operationId: job.operationId })).filter(c => c.power === power && c.role === kind);
            const attempt = Math.max(sentCalls(),tries + 1), final = attempt >= limit || error.code === 'CALL_LIMIT';
            // The recorded outcome says why; raw provider errors are never kept.
            const reason = error.code === 'PREFLIGHT' ? `PREFLIGHT${error.detail ? ` (${error.detail})` : ''}` : earlier.filter(c => c.dispatchedAt !== null).at(-1)?.outcome ?? error.code;
            try { this.options.talk!.onFailure?.({ phaseId: job.phaseId, power, round: kind, attempt, reason, final }); } catch { /* a diagnostic hook must never affect play */ }
            if (final) return;
          }
        }
      });
    };
    await round('ASK',alive,power => alive.filter(p => p !== power));
    if (lanes.state.failed || signal.aborted) return;
    const asked = (said: StoredPowerTalk[]) => said.filter(t => t.operationId === job.operationId && t.kind === 'ASK');
    const first = asked(await this.store.call('powerTalks',{ attemptId: job.attemptId }));
    await round('REPLY',alive.filter(p => first.some(t => t.messages.some(m => m.to === p))),(power,said) => asked(said).filter(t => t.messages.some(m => m.to === power)).map(t => t.power));
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

  private ask(job: DecisionContext['job'], power: Power, prompt: NonNullable<ReturnType<typeof lunaPrompt>>, earlier: ProviderCallRecord[], signal: AbortSignal,
      sibling: () => Promise<boolean> = async () => false, halted: () => boolean = () => false): Promise<PhaseAction> {
    return this.call(job,power,{ role: job.board.phase, id: n => `${job.operationId}:${power}:${n}`, limit: this.options.maxCallsPerPower ?? 3, request: prompt.request, maxCostNanousd: prompt.maxCostNanousd,
      validate: async (parsed,callSignal,id) => {
        let action: PhaseAction;
        try {
          action = prompt.set.toAction(prompt.read(parsed));
          await this.rules.validate(job.board,power,action,callSignal);
        } catch (error) {
          // A unit-by-unit answer explains itself; a bare list of numbers is described from its shape.
          const reason = callSignal.aborted ? null : prompt.byUnit ? (error instanceof ChoiceError ? error.message : 'the rules engine refused the combination') : describeRejection(parsed,prompt.set);
          if (reason) this.rejections.set(`${job.operationId}:${power}`,reason);
          try { this.options.onRejectedDecision?.({ phaseId: job.phaseId, power, attempt: earlier.filter(c => c.dispatchedAt !== null).length + 1,
            reason: reason ?? 'the phase was stopped before the answer could be checked' }); } catch { /* diagnostics never affect play */ }
          throw error;
        }
        callSignal.throwIfAborted();
        // Stored before the call is finished, so an interruption between the two cannot lose a paid answer.
        await this.store.call('saveProviderDecision',{ callId: id, action, now: this.now() });
        await this.options.boundary?.('decided',power,id);
        return action;
      } },earlier,signal,sibling,halted);
  }

  /** One reserved, recorded call for one power: reuse an unsent hold for exactly this request, otherwise reserve, count, dispatch and check. */
  private async call<T>(job: DecisionContext['job'], power: Power, spec: { role: ProviderCallIntent['role']; id: (ordinal: number) => string; limit: number;
      request: { body: string; requestHash: string; pricingVersion: string }; maxCostNanousd: number; validate: (parsed: unknown, signal: AbortSignal, id: string) => Promise<T> },
      earlier: ProviderCallRecord[], signal: AbortSignal, sibling: () => Promise<boolean> = async () => false, halted: () => boolean = () => false): Promise<T> {
    const prompt = spec;
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
      if (used >= spec.limit) fail('CALL_LIMIT');
      const intent: ProviderCallIntent = { id: spec.id(earlier.length + 1),
        fence: { operationId: job.operationId, attemptId: job.attemptId, phaseId: job.phaseId, revision: job.revision }, power, provider: contract.preset.provider, model: contract.preset.model,
        role: spec.role, pricingVersion: prompt.request.pricingVersion, requestHash: prompt.request.requestHash, maxCostNanousd: prompt.maxCostNanousd };
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
      catch (error) {
        // No generation sender was obtained: no model response was created and the hold is still PREPARED.
        await this.store.call('releaseProviderCall',{ id, now: this.now() }).catch(() => {});
        if (signal.aborted) fail('PAUSED_OR_CLOSED');
        throw new LunaDecisionError('PREFLIGHT',power,error instanceof PreflightError ? error.detail : undefined);
      }
    }
    try {
      return await recordedCall({ store: this.store, id, signal, timeoutMs: this.options.timeoutMs ?? contract.preset.timeoutMs, now: this.now,
        transport: async s => { const response = await transport({ body: prompt.request.body, signal: s }); return contract.normalizeResponse(response.body,response.status); },
        validate: (parsed,callSignal) => spec.validate(parsed,callSignal,id) });
    } catch (error) {
      if (error instanceof LunaDecisionError) throw error;
      // The call's own outcome (invalid, refused, timeout, cancelled…) is already recorded with its billing.
      return fail(error instanceof ProviderCallError && error.outcome === 'CANCELLED' ? 'PAUSED_OR_CLOSED' : 'PROVIDER');
    }
  }
}

/** "SPRING 1901" from a phase id, which ends in year, season and phase. */
const turnOf = (phaseId: string): string => { const parts = phaseId.split(':'); return `${parts.at(-2)} ${parts.at(-3)}`; };

/** What was wrong with an orders answer, in terms of the list it was given. Never the answer's own text. */
export function describeRejection(parsed: unknown, set: NonNullable<ReturnType<typeof lunaPrompt>>['set']): string {
  const picks = (parsed as { choices?: unknown } | null)?.choices;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(picks) || picks.some(i => !Number.isSafeInteger(i))) return 'the answer was not {"choices":[numbers]}';
  const numbers = picks as number[], outside = numbers.filter(i => i < 0 || i >= set.choices.length).length, repeated = numbers.length - new Set(numbers).size;
  const perGroup = new Map<string, number>();
  for (const i of numbers) if (i >= 0 && i < set.choices.length) perGroup.set(set.choices[i].group,(perGroup.get(set.choices[i].group) ?? 0) + 1);
  const parts = [`${numbers.length} number${numbers.length === 1 ? '' : 's'} for ${set.groups.length} ${set.phase === 'ORDERS' ? 'unit' : 'slot'}${set.groups.length === 1 ? '' : 's'}`];
  if (outside) parts.push(`${outside} not on the list`);
  if (repeated) parts.push(`${repeated} repeated`);
  if (set.phase === 'BUILDS') {
    const doubled = set.groups.filter(g => (perGroup.get(g.id) ?? 0) > 1 && set.groups.length > 1).map(g => g.label.replace(/^Build in /,''));
    if (doubled.length) parts.push(`more than one build in ${doubled.join(', ')}`);
    else if (!outside && !repeated) {
      const limit = /Pick (?:up to|exactly) (\d+)/.exec(set.rule)?.[1];
      parts.push(limit && numbers.length > Number(limit) ? `the rule allows ${limit} in total, not one under every heading` : 'not the number of choices the rule asks for');
    }
  } else {
    const missed = set.groups.filter(g => !perGroup.has(g.id)).map(g => g.label), doubled = set.groups.filter(g => (perGroup.get(g.id) ?? 0) > 1).map(g => g.label);
    if (missed.length) parts.push(`nothing for ${missed.join(', ')}`);
    if (doubled.length) parts.push(`more than one for ${doubled.join(', ')}`);
    if (!outside && !repeated && !missed.length && !doubled.length) parts.push('the rules engine refused the combination');
  }
  return parts.join('; ');
}
