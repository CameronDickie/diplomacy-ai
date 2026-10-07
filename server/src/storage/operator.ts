import type { DatabaseSync } from 'node:sqlite';
import { parseBoard } from '../fixtures/BoardFixture.js';
import { OutboxRepository } from './outbox.js';
import { FundingRepository } from './funding.js';
import { StoreError, type OperatorAttemptRow, type PaidState, type SpendTotals, type StoreOperations } from './contracts.js';

const invalid = (): never => { throw new StoreError('STORE_INVALID','Invalid operator request.'); };
const time = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) invalid(); };
const id = (s: string) => { if (typeof s !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(s)) invalid(); };
const RUNNING: PaidState = { stopped:false, episode:0, updatedAt:null };

/** Stops paid play for a non-operator reason. Idempotent while stopped; a new stop opens a new pause. */
export function stopPaid(db: DatabaseSync, reason: 'BUDGET_EXHAUSTED' | 'COST_ANOMALY', now: number): void {
  const current = paidState(db);
  if (!current.stopped) db.prepare(`INSERT INTO operator_state(key,value_json,updated_at) VALUES('paid',?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify({stopped:true,episode:current.episode+1}),now);
  // One audit line per cause per pause, not one per refused call.
  if (!current.stopped || !db.prepare("SELECT 1 FROM operator_audit WHERE action=? AND at>=?").get(reason,current.updatedAt ?? 0))
    db.prepare("INSERT INTO operator_audit(at,operator_id,action,target) VALUES(?,'system',?,NULL)").run(now,reason);
}
export function paidState(db: DatabaseSync): PaidState {
  const row = db.prepare("SELECT value_json,updated_at FROM operator_state WHERE key='paid'").get();
  return row ? { ...JSON.parse(String(row.value_json)), updatedAt:Number(row.updated_at) } : RUNNING;
}
/** Sums every provider record, optionally for one attempt. Unresolved calls count at their reserved maximum. */
export function spendTotals(db: DatabaseSync, attemptId?: string): SpendTotals {
  const r = db.prepare(`SELECT count(*) calls,
    sum(CASE WHEN usage_json IS NULL THEN 1 ELSE 0 END) unresolved,
    sum(COALESCE(json_extract(usage_json,'$.costNanousd'),0)) cost,
    sum(CASE WHEN usage_json IS NULL THEN json_extract(intent_json,'$.maxCostNanousd') ELSE 0 END) liability,
    sum(COALESCE(json_extract(usage_json,'$.inputTokens'),0)) input,
    sum(COALESCE(json_extract(usage_json,'$.outputTokens'),0)) output
    FROM provider_calls WHERE (?1 IS NULL OR attempt_id=?1)`).get(attemptId ?? null)!;
  return { calls:Number(r.calls), unresolvedCalls:Number(r.unresolved??0), knownCostNanousd:Number(r.cost??0), unresolvedLiabilityNanousd:Number(r.liability??0), inputTokens:Number(r.input??0), outputTokens:Number(r.output??0) };
}

/** Methods run inside the worker transaction. Nothing here returns display names, subjects, sessions or provider payloads. */
export class OperatorRepository {
  constructor(private db: DatabaseSync) {}
  private audit(operatorId: string, action: string, target: string | null, now: number): void {
    id(operatorId); time(now);
    this.db.prepare('INSERT INTO operator_audit(at,operator_id,action,target) VALUES(?,?,?,?)').run(now,operatorId,action,target);
  }
  private row(r: Record<string, unknown>): OperatorAttemptRow {
    const board = parseBoard(JSON.parse(String(r.board_json)));
    return { id:String(r.id), playerId:String(r.player_id), playerProvider:r.provider as OperatorAttemptRow['playerProvider'], playerBanned:r.banned_at !== null,
      challengeId:String(r.challenge_id), challengeVersion:Number(r.challenge_version), mode:r.opponents === 'LUNA' ? 'SPONSORED' : Number(r.practice_bot) === 1 ? 'BOT' : 'PRACTICE', lifecycle:r.lifecycle as OperatorAttemptRow['lifecycle'], execution:r.execution as OperatorAttemptRow['execution'],
      year:board.year, season:board.season, phase:board.phase, createdAt:Number(r.created_at), updatedAt:Number(r.updated_at), lastActivityAt:Number(r.last_activity_at) };
  }
  overview(): StoreOperations['operatorOverview']['output'] {
    const attempts = this.db.prepare(`SELECT a.*,p.provider,p.banned_at FROM attempts a JOIN players p ON p.id=a.player_id
      ORDER BY (a.lifecycle='ACTIVE') DESC,a.updated_at DESC,a.id LIMIT 50`).all().map(r => this.row(r));
    const outbox = new OutboxRepository(this.db);
    return { funding:new FundingRepository(this.db).totals(), activeAttempts:Number(this.db.prepare("SELECT count(*) n FROM attempts WHERE lifecycle='ACTIVE'").get()!.n), attempts, spend:spendTotals(this.db), paid:paidState(this.db),
      outbox:{counts:outbox.counts(),recent:outbox.recent(20)},
      audit:this.db.prepare('SELECT at,operator_id,action,target FROM operator_audit ORDER BY id DESC LIMIT 20').all().map(r => ({at:Number(r.at),operatorId:String(r.operator_id),action:String(r.action),target:r.target===null?null:String(r.target)})) };
  }
  attempt(input: StoreOperations['operatorAttempt']['input']): StoreOperations['operatorAttempt']['output'] {
    id(input.id);
    const r = this.db.prepare('SELECT a.*,p.provider,p.banned_at FROM attempts a JOIN players p ON p.id=a.player_id WHERE a.id=?').get(input.id);
    if (!r) return null;
    return { attempt:this.row(r), board:parseBoard(JSON.parse(String(r.board_json))), score:r.score_json===null?null:JSON.parse(String(r.score_json)),
      reports:this.db.prepare('SELECT report_json FROM reports WHERE attempt_id=? ORDER BY sequence').all(input.id).map(x => JSON.parse(String(x.report_json))), spend:spendTotals(this.db,input.id), funding:new FundingRepository(this.db).attempt(input.id) };
  }
  /** Each running→stopped transition opens a new episode, the unit credit requests are counted against. */
  setPaid(input: StoreOperations['setPaidStopped']['input']): PaidState {
    time(input.now);
    if (typeof input.stopped !== 'boolean') invalid();
    const current = paidState(this.db);
    if (current.stopped !== input.stopped) {
      const next = { stopped:input.stopped, episode:current.episode + (input.stopped ? 1 : 0) };
      this.db.prepare(`INSERT INTO operator_state(key,value_json,updated_at) VALUES('paid',?,?)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(JSON.stringify(next),input.now);
    }
    this.audit(input.operatorId,input.stopped?'PAID_STOP':'PAID_RESUME',null,input.now);
    return paidState(this.db);
  }
  record(input: StoreOperations['recordOperatorAction']['input']): null {
    if (!['ATTEMPT_STOP','PLAYER_BAN','PLAYER_UNBAN','SPECTATE'].includes(input.action)) invalid();
    id(input.target); time(input.now);
    // Refreshing an open spectator view is one viewing, not a new audit line every few seconds.
    if (input.action === 'SPECTATE' && this.db.prepare("SELECT 1 FROM operator_audit WHERE operator_id=? AND action='SPECTATE' AND target=? AND at>?").get(input.operatorId,input.target,input.now-600_000)) return null;
    this.audit(input.operatorId,input.action,input.target,input.now); return null;
  }
  /** One request per account per stop episode; only meaningful while paid play is stopped. */
  requestCredit(input: StoreOperations['requestCredit']['input']): StoreOperations['requestCredit']['output'] {
    time(input.now);
    if (!this.db.prepare('SELECT id FROM players WHERE id=? AND banned_at IS NULL').get(input.playerId)) throw new StoreError('STORE_FORBIDDEN','Player is unavailable.');
    const paid = paidState(this.db);
    if (!paid.stopped) throw new StoreError('STORE_CONFLICT','Sponsored play is not paused, so there is nothing to request.');
    const created = new OutboxRepository(this.db).enqueue('CREDIT_REQUEST',`credit:${input.playerId}:${paid.episode}`,{playerId:input.playerId,episode:paid.episode,at:input.now},input.now);
    return { recorded:true, duplicate:!created };
  }
}
