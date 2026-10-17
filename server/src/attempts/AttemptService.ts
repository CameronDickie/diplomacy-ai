import { randomUUID } from 'node:crypto';
import { Store } from '../storage/Store.js';
import { StoreError, type StoredAttempt, type StoredReceipt } from '../storage/contracts.js';
import { actionFingerprint } from '../storage/phases.js';
import { parseAction, parseDecisions } from './actions.js';
import type { PhaseDecisions, PhaseJob } from './types.js';
import { PhaseRules, idleAction } from './PhaseRules.js';

export interface DecisionContext { readonly job: PhaseJob; readonly signal: AbortSignal }
export interface DecisionProvider {
  decide(context: DecisionContext): Promise<PhaseDecisions>;
  /** Must reconcile the original operation's liabilities before any new paid dispatch. */
  recover(context: DecisionContext): Promise<PhaseDecisions>;
}
export function offlineDecisions(rules: PhaseRules): DecisionProvider {
  const decide = ({job,signal}: DecisionContext) => rules.defaults(job,signal);
  return {decide,recover:decide};
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
type HookStage = 'intent' | 'decisions' | 'resolved' | 'committed';
/** The longest a phase may run: a full game with a person in it waits for them (development only). */
export const HUMAN_PHASE_LIMIT_MS = 7 * 24 * 3_600_000;
type Options = { maxRunning?: number; idleExpireMs?:number; timeoutMs?: number; now?: () => number; measurementClock?: () => number; boundary?: (stage: HookStage, job: PhaseJob) => Promise<void>;
  /** Told why a phase could not complete. For diagnostics only: the durable RECOVERING state is what matters. */
  onPhaseFailure?: (job: PhaseJob, error: unknown) => void };

/** SQLite is authority. In-memory promises only coalesce work and deliver cancellation. */
export class AttemptService {
  private running = new Map<string,{operationId:string;playerId:string;controller:AbortController;done:Promise<void>}>();
  private closed = false;
  private validating = 0;
  private submissions = new Set<Promise<StoredReceipt>>();
  private validationControllers = new Set<AbortController>();
  private now: () => number;
  constructor(private store: Store, private provider: DecisionProvider, private rules = new PhaseRules(), private options: Options = {}) {
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(options.maxRunning ?? 3) || (options.maxRunning ?? 3) < 1 || (options.maxRunning ?? 3) > 100 ||
      !Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1 || (options.timeoutMs ?? 30_000) > HUMAN_PHASE_LIMIT_MS)
      throw new Error('Invalid phase worker limits.');
  }
  submit(input: {attemptId:string;playerId:string;revision:number;phaseId:string;requestId:string;action:unknown}): Promise<StoredReceipt> {
    const pending = this.submitInternal(input);
    this.submissions.add(pending);
    void pending.finally(() => this.submissions.delete(pending)).catch(() => {});
    return pending;
  }
  private async submitInternal(input: {attemptId:string;playerId:string;revision:number;phaseId:string;requestId:string;action:unknown}): Promise<StoredReceipt> {
    const action = parseAction(input.action);
    const prior = await this.store.call('receipt',{attemptId:input.attemptId,playerId:input.playerId,requestId:input.requestId});
    if (prior) {
      if (prior.fingerprint !== actionFingerprint(input.phaseId,action)) throw new StoreError('STORE_CONFLICT','Request ID was already used for a different submission.');
      return prior;
    }
    if (this.closed || this.running.size + this.validating >= (this.options.maxRunning ?? 3)) throw new StoreError('STORE_BUSY','Phase capacity is full. Retry shortly.');
    this.validating++;
    const validation = new AbortController();
    this.validationControllers.add(validation);
    try {
      const attempt = await this.store.call('attempt',{id:input.attemptId,playerId:input.playerId});
      if (!attempt) throw new StoreError('STORE_FORBIDDEN','Attempt is unavailable to this player.');
      if (attempt.lifecycle !== 'ACTIVE' || attempt.execution !== 'ACCEPTING' || attempt.revision !== input.revision || attempt.phaseId !== input.phaseId)
        throw new StoreError('STORE_CONFLICT','This phase changed or already has saved orders. Reload its committed state.');
      const challenge = await this.store.call('challenge',{id:attempt.challengeId,version:attempt.challengeVersion});
      await this.rules.validate(attempt.board,challenge!.definition.humanPower,action,AbortSignal.any([validation.signal,AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]));
      if (this.closed) throw new StoreError('STORE_UNAVAILABLE','Phase service is shutting down.');
      const accepted = await this.store.call('beginPhase',{id:attempt.id,playerId:input.playerId,expectedRevision:input.revision,phaseId:input.phaseId,
        requestId:input.requestId,operationId:randomUUID(),action,measuredAt:this.options.measurementClock?.(),idleBefore:this.options.idleExpireMs ? this.now()-this.options.idleExpireMs : undefined,now:this.now()});
      if (!accepted.duplicate) this.launch(accepted.job,false);
      return accepted.receipt;
    } finally { this.validating--; this.validationControllers.delete(validation); validation.abort(); }
  }
  private launch(job: PhaseJob, recovery: boolean): Promise<void> {
    const current = this.running.get(job.attemptId);
    if (current) return current.done;
    if (this.closed || this.running.size >= (this.options.maxRunning ?? 3)) return Promise.resolve();
    const controller = new AbortController();
    const done = Promise.resolve().then(() => this.run(job,recovery,controller)).finally(() => this.running.delete(job.attemptId));
    this.running.set(job.attemptId,{operationId:job.operationId,playerId:job.playerId,controller,done});
    // Every asynchronous failure is retained in durable RECOVERING state where possible.
    void done.catch(() => {});
    return done;
  }
  /**
   * A phase that asks nothing of the player (another power's retreat, a winter with no change for them)
   * is entered on their behalf, so they are only ever asked for input when they have a decision to make.
   * Each such phase is an ordinary durable phase with its own job, opponents' decisions and report.
   */
  private async run(initial: PhaseJob, recovery: boolean, controller: AbortController): Promise<void> {
    let job: PhaseJob | null = initial;
    // Bounded: a player with no units at all is asked nothing every phase, and must not turn one
    // submission into an unbounded run. Past the bound the attempt simply waits for a Continue.
    for (let chained = 0; job; chained++) {
      const committed = await this.runOne(job,recovery && chained === 0,controller);
      job = committed && chained < 7 && !controller.signal.aborted && !this.closed ? await this.enterIdlePhase(initial).catch(() => null) : null;
    }
  }
  private async enterIdlePhase(previous: PhaseJob): Promise<PhaseJob | null> {
    const attempt = await this.store.call('attempt',{id:previous.attemptId,playerId:previous.playerId});
    if (!attempt || attempt.lifecycle !== 'ACTIVE' || attempt.execution !== 'ACCEPTING') return null;
    const action = idleAction(attempt.board,previous.definition.humanPower);
    if (!action) return null;
    const accepted = await this.store.call('beginPhase',{id:attempt.id,playerId:previous.playerId,expectedRevision:attempt.revision,phaseId:attempt.phaseId,
      requestId:`auto-${attempt.revision}`,operationId:randomUUID(),action,measuredAt:this.options.measurementClock?.(),now:this.now()});
    return accepted.duplicate ? null : accepted.job;
  }
  /** Runs one phase to its commit. Returns whether it committed. */
  private async runOne(initial: PhaseJob, recovery: boolean, outer: AbortController): Promise<boolean> {
    let job = initial;
    // Each phase gets its own deadline; stopping the attempt still cancels whichever one is running.
    const controller = new AbortController(), forward = () => controller.abort();
    outer.signal.addEventListener('abort',forward,{once:true}); if (outer.signal.aborted) forward();
    const timer = setTimeout(() => controller.abort(new Error('Phase deadline exceeded.')),this.options.timeoutMs ?? 30_000);
    const signal = controller.signal;
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve,reject) => { abort=()=>reject(new Error('Phase processing interrupted.')); signal.addEventListener('abort',abort,{once:true}); if(signal.aborted)abort(); });
      try { return await Promise.race([work,cancelled]); }
      finally { signal.removeEventListener('abort',abort); }
    };
    try {
      if (recovery) job = await this.store.call('recoverPhase',{fence:job,countRecovery:true,now:this.now()});
      await this.options.boundary?.('intent',job);
      signal.throwIfAborted();
      if (!job.decisions) {
        // Providers never receive live board references or authority to commit a phase.
        const context = {job:freeze(structuredClone(job)),signal};
        const decisions = parseDecisions(await bounded(recovery ? this.provider.recover(context) : this.provider.decide(context)));
        await bounded(this.rules.validateDecisions(job,decisions,signal));
        signal.throwIfAborted();
        job = await this.store.call('saveDecisions',{fence:job,decisions,now:this.now()});
      }
      await this.options.boundary?.('decisions',job);
      const result = await bounded(this.rules.resolve(freeze(structuredClone(job)),signal));
      await this.options.boundary?.('resolved',job);
      signal.throwIfAborted();
      await this.store.call('commitPhase',{fence:job,...result,measuredAt:this.options.measurementClock?.(),now:this.now()});
      await this.options.boundary?.('committed',job);
      return true;
    } catch (error) {
      try { this.options.onPhaseFailure?.(job,error); } catch { /* a diagnostic hook must never affect recovery */ }
      // A stale/terminal fence or uncertain store failure must never be retried as a new command.
      await this.store.call('recoverPhase',{fence:job,now:this.now()}).catch(() => {});
      return false;
    } finally { clearTimeout(timer); outer.signal.removeEventListener('abort',forward); controller.abort(); }
  }
  async recover(attemptId?:string): Promise<void> {
    const jobs = (await this.store.call('pendingPhaseJobs',{})).filter(job=>!attemptId||job.attemptId===attemptId);
    // One bounded batch at a time. A failed recovery remains visible; no automatic retry loop.
    const concurrency = Math.max(1,this.options.maxRunning ?? 3);
    for (let index=0; index<jobs.length && !this.closed; index+=concurrency)
      await Promise.all(jobs.slice(index,index+concurrency).map(job => this.launch(job,true)));
  }
  async wait(attemptId: string): Promise<void> { await this.running.get(attemptId)?.done; }
  async terminate(id:string,playerId:string,lifecycle:'ABANDONED'|'EXPIRED'|'STOPPED',idleBefore?:number): Promise<StoredAttempt> {
    const result = await this.store.call('terminateAttempt',{id,playerId,lifecycle,idleBefore,now:this.now()});
    if(result.lifecycle !== 'ACTIVE') this.running.get(id)?.controller.abort();
    return result;
  }
  /** Returns the session hashes the ban revoked so live sockets can be dropped. */
  async banPlayer(playerId:string,banned=true): Promise<string[]> {
    const {sessions} = await this.store.call('banPlayer',{playerId,banned,now:this.now()});
    if (banned) for (const work of this.running.values()) if (work.playerId === playerId) work.controller.abort();
    return sessions;
  }
  /** Removes the account's rows first; aborted work then fails its fence and cannot dispatch or commit. */
  async deleteAccount(playerId:string): Promise<string[]> {
    const removed = await this.store.call('deleteAccount',{playerId,now:this.now()});
    for (const work of this.running.values()) if (work.playerId === playerId) work.controller.abort();
    return removed.sessions;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.validationControllers) controller.abort();
    for (const {controller} of this.running.values()) controller.abort();
    await Promise.allSettled([...this.submissions]);
    await Promise.allSettled([...this.running.values()].map(v => v.done));
  }
}
