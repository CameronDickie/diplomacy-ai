import type { DatabaseSync } from 'node:sqlite';
import type { ProviderCallIntent } from '../providers/accounting.js';
import { StoreError, type FundingTotals, type ProviderBudget, type StoreOperations } from './contracts.js';
import { stopPaid } from './operator.js';

const invalid = (): never => { throw new StoreError('STORE_INVALID','Invalid funding request.'); };
const time = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) invalid(); };
/** Policy ceiling for any one attempt; the configured operating cap must sit at or below it. */
/** Policy ceiling for any one attempt; the configured operating cap must sit at or below it. */
export const ATTEMPT_CAP_LIMIT_NANOUSD = 15_000_000_000;
/** FUNDS_BUSY: the hold does not fit only because sibling calls of the same phase are still holding their worst case. */
export type Refusal = { refused: 'BUDGET_EXHAUSTED' | 'ATTEMPT_BUDGET_EXHAUSTED' | 'FUNDS_BUSY' };

/**
 * The single cumulative ledger. Methods run inside the worker's BEGIN IMMEDIATE transaction.
 *
 *   ceiling   = sum of explicit grants (optionally lowered by a configured limit), never reset
 *   settled   = every known cost ever reconciled, kept after receipts and attempts are pruned
 *   held      = worst-case reservations for calls whose cost is not yet known
 *   available = ceiling - settled - held
 *
 * Nothing here refunds on abandon, expiry, ban, deletion, restart or cleanup. A reservation is
 * released only for a call that provably never left the process.
 *
 * A grant may also name a provider. That provider then has a budget of its own, mirroring the owner's
 * account with it: from its first such grant, each of its calls must fit both the pool and its budget.
 */
export class FundingRepository {
  constructor(private db: DatabaseSync) {}
  private pool() { return this.db.prepare('SELECT settled_nanousd,attempt_cap_nanousd,ceiling_limit_nanousd FROM funding_pool WHERE id=1').get()!; }
  private heldTotal(attemptId?: string): number {
    return Number(this.db.prepare("SELECT COALESCE(sum(reserved_nanousd),0) n FROM reservations WHERE state='HELD' AND (?1 IS NULL OR attempt_id=?1)").get(attemptId ?? null)!.n);
  }
  totals(): FundingTotals {
    const pool = this.pool(), grants = this.db.prepare('SELECT count(*) n,COALESCE(sum(amount_nanousd),0) total FROM funding_grants').get()!;
    const granted = Number(grants.total), limit = pool.ceiling_limit_nanousd === null ? null : Number(pool.ceiling_limit_nanousd);
    const ceiling = limit === null ? granted : Math.min(granted,limit), settled = Number(pool.settled_nanousd), held = this.heldTotal();
    // In flight: prepared or dispatched and still expected to report. Unknown: finished, or answered, without usable usage.
    const unknown = Number(this.db.prepare(`SELECT COALESCE(sum(r.reserved_nanousd),0) n FROM reservations r LEFT JOIN provider_calls c ON c.id=r.call_id
      WHERE r.state='HELD' AND (c.id IS NULL OR c.outcome IS NOT NULL OR c.received_at IS NOT NULL)`).get()!.n);
    return { grantedNanousd:granted, ceilingNanousd:ceiling, settledNanousd:settled, reservedNanousd:held-unknown, unknownLiabilityNanousd:unknown,
      availableNanousd:Math.max(0,ceiling-settled-held), attemptCapNanousd:Number(pool.attempt_cap_nanousd), grants:Number(grants.n),
      providers:{ OPENAI:this.budget('OPENAI'), ANTHROPIC:this.budget('ANTHROPIC') } };
  }
  /** One provider's budget: its grants, and its calls reserved since the first of them (settled, extra charges, held). */
  private budget(provider: 'OPENAI' | 'ANTHROPIC'): ProviderBudget | null {
    const grants = this.db.prepare('SELECT count(*) n,COALESCE(sum(amount_nanousd),0) total,min(granted_at) since FROM funding_grants WHERE provider=?').get(provider)!;
    if (!Number(grants.n)) return null;
    const since = Number(grants.since), calls = `FROM reservations r JOIN provider_calls c ON c.id=r.call_id WHERE json_extract(c.intent_json,'$.provider')=?1 AND r.created_at>=?2`;
    const settled = Number(this.db.prepare(`SELECT COALESCE(sum(r.settled_nanousd),0) n ${calls} AND r.state='SETTLED'`).get(provider,since)!.n)
      + Number(this.db.prepare(`SELECT COALESCE(sum(a.delta_nanousd),0) n FROM funding_adjustments a JOIN reservations r ON r.call_id=a.call_id JOIN provider_calls c ON c.id=r.call_id
        WHERE json_extract(c.intent_json,'$.provider')=?1 AND r.created_at>=?2`).get(provider,since)!.n);
    const held = Number(this.db.prepare(`SELECT COALESCE(sum(r.reserved_nanousd),0) n ${calls} AND r.state='HELD'`).get(provider,since)!.n), granted = Number(grants.total);
    return { grantedNanousd:granted, settledNanousd:settled, heldNanousd:held, availableNanousd:Math.max(0,granted-settled-held), since, grants:Number(grants.n) };
  }
  attempt(attemptId: string): { settledNanousd: number; heldNanousd: number } {
    return { settledNanousd:Number(this.db.prepare('SELECT settled_nanousd FROM attempt_spend WHERE attempt_id=?').get(attemptId)?.settled_nanousd ?? 0), heldNanousd:this.heldTotal(attemptId) };
  }
  /** Replenishment. The reference makes a repeated command harmless and a reused reference with another amount an error. */
  grant(input: StoreOperations['grantFunding']['input']): FundingTotals {
    time(input.now);
    if (!Number.isSafeInteger(input.amountNanousd) || input.amountNanousd < 1 || input.amountNanousd > 1_000_000_000_000_000) invalid();
    if (typeof input.authorizationRef !== 'string' || !/^[A-Za-z0-9:_.-]{8,100}$/.test(input.authorizationRef) || typeof input.grantedBy !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(input.grantedBy)) invalid();
    const provider = input.provider ?? null;
    if (provider !== null && provider !== 'OPENAI' && provider !== 'ANTHROPIC') invalid();
    const prior = this.db.prepare('SELECT amount_nanousd,provider FROM funding_grants WHERE authorization_ref=?').get(input.authorizationRef);
    if (prior) { if (Number(prior.amount_nanousd) !== input.amountNanousd || (prior.provider ?? null) !== provider) throw new StoreError('STORE_CONFLICT','This authorization reference was already used for a different amount or provider.'); return this.totals(); }
    this.db.prepare('INSERT INTO funding_grants(authorization_ref,amount_nanousd,granted_at,granted_by,provider) VALUES(?,?,?,?,?)').run(input.authorizationRef,input.amountNanousd,input.now,input.grantedBy,provider);
    return this.totals();
  }
  /** Server-owned operating limits. A limit can only narrow what grants allow; it is never a source of funds. */
  policy(input: StoreOperations['setFundingPolicy']['input']): FundingTotals {
    time(input.now);
    if (!Number.isSafeInteger(input.attemptCapNanousd) || input.attemptCapNanousd < 1 || input.attemptCapNanousd > ATTEMPT_CAP_LIMIT_NANOUSD) invalid();
    if (input.ceilingLimitNanousd !== null && (!Number.isSafeInteger(input.ceilingLimitNanousd) || input.ceilingLimitNanousd < 0)) invalid();
    // Re-applying the same policy at every startup writes nothing.
    this.db.prepare('UPDATE funding_pool SET attempt_cap_nanousd=?1,ceiling_limit_nanousd=?2,updated_at=?3 WHERE id=1 AND (attempt_cap_nanousd<>?1 OR ceiling_limit_nanousd IS NOT ?2)').run(input.attemptCapNanousd,input.ceilingLimitNanousd,input.now);
    return this.totals();
  }
  /**
   * Holds the call's worst-case cost. Returns a refusal instead of throwing so the stop written on
   * exhaustion commits with the caller's transaction.
   */
  reserve(intent: ProviderCallIntent, now: number): Refusal | null {
    const amount = intent.maxCostNanousd, pool = this.pool(), own = this.attempt(intent.fence.attemptId);
    // Concurrent decisions of one phase each hold a full worst case and then settle for a fraction of it.
    // While any of them is still unanswered, "does not fit" means "wait", not "the money is gone".
    const siblingsInFlight = () => Boolean(this.db.prepare(`SELECT 1 FROM reservations r JOIN provider_calls c ON c.id=r.call_id
      WHERE r.state='HELD' AND c.operation_id=? AND c.outcome IS NULL AND c.received_at IS NULL LIMIT 1`).get(intent.fence.operationId));
    // The attempt cap is checked first: one costly attempt must not be reported as an empty pool.
    if (own.settledNanousd + own.heldNanousd + amount > Number(pool.attempt_cap_nanousd)) return { refused: siblingsInFlight() ? 'FUNDS_BUSY' : 'ATTEMPT_BUDGET_EXHAUSTED' };
    const totals = this.totals(), budget = totals.providers[intent.provider];
    // A provider with a budget of its own is limited by it as well: its account can run out before the pool does.
    if (amount > totals.availableNanousd || (budget && amount > budget.availableNanousd)) {
      if (siblingsInFlight()) return { refused:'FUNDS_BUSY' };
      stopPaid(this.db,'BUDGET_EXHAUSTED',now);
      return { refused:'BUDGET_EXHAUSTED' };
    }
    this.db.prepare("INSERT INTO reservations(call_id,attempt_id,reserved_nanousd,state,created_at) VALUES(?,?,?,'HELD',?)").run(intent.id,intent.fence.attemptId,amount,now);
    return null;
  }
  /** A queued call's hold must still fit policy when it actually leaves the process. */
  dispatchAllowed(intent: ProviderCallIntent, now: number): Refusal | null {
    const own=this.attempt(intent.fence.attemptId),totals=this.totals();
    if(own.settledNanousd+own.heldNanousd>totals.attemptCapNanousd)return {refused:'ATTEMPT_BUDGET_EXHAUSTED'};
    const budget=totals.providers[intent.provider];
    if(totals.settledNanousd+totals.reservedNanousd+totals.unknownLiabilityNanousd>totals.ceilingNanousd||(budget&&budget.settledNanousd+budget.heldNanousd>budget.grantedNanousd)){
      stopPaid(this.db,'BUDGET_EXHAUSTED',now);return {refused:'BUDGET_EXHAUSTED'};
    }
    return null;
  }
  /** Called once, when a call's usage first becomes known. The full cost is kept even above its reservation. */
  settle(callId: string, attemptId: string, costNanousd: number, now: number): void {
    const reservation = this.db.prepare('SELECT reserved_nanousd,settled_nanousd,state FROM reservations WHERE call_id=?').get(callId);
    if (reservation?.state === 'SETTLED') {
      // A manually verified liability may later report a different actual bill.
      // Keep the original closed reservation immutable and record only the extra
      // charge. A lower bill never refunds the conservative amount already spent.
      const credited = Number(reservation.settled_nanousd);
      if (costNanousd !== credited && !this.db.prepare('SELECT 1 FROM funding_adjustments WHERE call_id=?').get(callId)) {
        const delta = Math.max(0,costNanousd-credited);
        this.db.prepare('INSERT INTO funding_adjustments(call_id,attempt_id,credited_nanousd,actual_nanousd,delta_nanousd,recorded_at) VALUES(?,?,?,?,?,?)')
          .run(callId,attemptId,credited,costNanousd,delta,now);
        this.db.prepare('UPDATE funding_pool SET settled_nanousd=settled_nanousd+?,updated_at=? WHERE id=1').run(delta,now);
        this.db.prepare('UPDATE attempt_spend SET settled_nanousd=settled_nanousd+? WHERE attempt_id=?').run(delta,attemptId);
        stopPaid(this.db,'COST_ANOMALY',now);
      }
      return;
    }
    if (reservation?.state === 'HELD') this.db.prepare("UPDATE reservations SET state='SETTLED',settled_nanousd=?,closed_at=? WHERE call_id=?").run(costNanousd,now,callId);
    else if (!reservation) this.db.prepare("INSERT INTO reservations(call_id,attempt_id,reserved_nanousd,state,settled_nanousd,created_at,closed_at) VALUES(?,?,?,'SETTLED',?,?,?)").run(callId,attemptId,Math.max(1,costNanousd),costNanousd,now,now);
    this.db.prepare('UPDATE funding_pool SET settled_nanousd=settled_nanousd+?,updated_at=? WHERE id=1').run(costNanousd,now);
    this.db.prepare('INSERT INTO attempt_spend(attempt_id,settled_nanousd,calls) VALUES(?,?,1) ON CONFLICT(attempt_id) DO UPDATE SET settled_nanousd=settled_nanousd+excluded.settled_nanousd,calls=calls+1').run(attemptId,costNanousd);
    // A bill above its worst-case estimate means the estimate is wrong: stop admitting more on it.
    const overEstimate = !reservation || reservation.state === 'RELEASED' || costNanousd > Number(reservation.reserved_nanousd);
    if (overEstimate || this.totals().settledNanousd > this.totals().ceilingNanousd) stopPaid(this.db,'COST_ANOMALY',now);
  }
  /**
   * Closes a held reservation at an amount the owner has verified with the provider, for a call
   * that ended without reporting usage. Zero is allowed when the provider confirms no charge.
   * Like a grant it needs host access and a reference, and it is recorded in the audit trail.
   */
  resolve(input: StoreOperations['resolveLiability']['input']): FundingTotals {
    time(input.now);
    if (!Number.isSafeInteger(input.costNanousd) || input.costNanousd < 0 || input.costNanousd > 1_000_000_000_000 || typeof input.authorizationRef !== 'string' || !/^[A-Za-z0-9:_.-]{8,100}$/.test(input.authorizationRef)) invalid();
    const row = this.db.prepare(`SELECT r.state,r.attempt_id,r.reserved_nanousd,c.state call_state,c.outcome,c.received_at FROM reservations r LEFT JOIN provider_calls c ON c.id=r.call_id WHERE r.call_id=?`).get(input.callId);
    // A call still in flight may yet report its own usage; only an ended one can be resolved by hand.
    if (!row || row.state !== 'HELD' || (row.call_state !== null && row.outcome === null && row.received_at === null)) throw new StoreError('STORE_CONFLICT','Only a held reservation for a call that has ended can be resolved.');
    this.db.prepare("UPDATE reservations SET state='SETTLED',settled_nanousd=?,closed_at=? WHERE call_id=?").run(input.costNanousd,input.now,input.callId);
    this.db.prepare('UPDATE funding_pool SET settled_nanousd=settled_nanousd+?,updated_at=? WHERE id=1').run(input.costNanousd,input.now);
    this.db.prepare('INSERT INTO attempt_spend(attempt_id,settled_nanousd,calls) VALUES(?,?,1) ON CONFLICT(attempt_id) DO UPDATE SET settled_nanousd=settled_nanousd+excluded.settled_nanousd,calls=calls+1').run(String(row.attempt_id),input.costNanousd);
    this.db.prepare("INSERT INTO operator_audit(at,operator_id,action,target) VALUES(?,?,'LIABILITY_RESOLVED',?)").run(input.now,`cli:${input.authorizationRef}`.slice(0,100),input.callId);
    if (input.costNanousd > Number(row.reserved_nanousd) || this.totals().settledNanousd > this.totals().ceilingNanousd) stopPaid(this.db,'COST_ANOMALY',input.now);
    return this.totals();
  }
  /** Lists what is still held, oldest first, so the owner can look each call up with the provider. */
  held(): StoreOperations['heldLiabilities']['output'] {
    return this.db.prepare(`SELECT r.call_id,r.attempt_id,r.reserved_nanousd,r.created_at,c.state,c.outcome,c.response_id FROM reservations r LEFT JOIN provider_calls c ON c.id=r.call_id
      WHERE r.state='HELD' ORDER BY r.created_at,r.call_id LIMIT 500`).all().map(r => ({ callId:String(r.call_id), attemptId:String(r.attempt_id), reservedNanousd:Number(r.reserved_nanousd), createdAt:Number(r.created_at),
        callState:r.state === null ? null : String(r.state), outcome:r.outcome === null ? null : String(r.outcome), responseId:r.response_id === null ? null : String(r.response_id) }));
  }
  /** Only a call still PREPARED can be released: dispatch is the durable claim taken before any network use. */
  private release(callId: string, now: number): void {
    this.db.prepare("UPDATE provider_calls SET state='FINISHED',outcome='CANCELLED',finished_at=? WHERE id=? AND state='PREPARED'").run(now,callId);
    this.db.prepare("UPDATE reservations SET state='RELEASED',closed_at=? WHERE call_id=? AND state='HELD'").run(now,callId);
  }
  releasePrepared(input: StoreOperations['releaseProviderCall']['input']): FundingTotals {
    time(input.now);
    const call = this.db.prepare('SELECT state FROM provider_calls WHERE id=?').get(input.id);
    if (!call || call.state !== 'PREPARED') throw new StoreError('STORE_CONFLICT','Only a call that was never dispatched can be released.');
    this.release(input.id,input.now);
    return this.totals();
  }
  /** Releases never-dispatched calls whose attempt or phase can no longer run them. Dispatched calls are left alone. */
  reconcile(now: number): number {
    time(now);
    const dead = this.db.prepare(`SELECT c.id FROM provider_calls c JOIN reservations r ON r.call_id=c.id AND r.state='HELD'
      LEFT JOIN attempts a ON a.id=c.attempt_id LEFT JOIN phase_jobs j ON j.id=c.operation_id
      WHERE c.state='PREPARED' AND (a.id IS NULL OR a.lifecycle<>'ACTIVE' OR j.id IS NULL OR j.status IN ('COMMITTED','CANCELLED')) LIMIT 500`).all();
    for (const row of dead) this.release(String(row.id),now);
    return dead.length;
  }
}
