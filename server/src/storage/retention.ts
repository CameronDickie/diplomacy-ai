import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { StoreError, type StoreOperations } from './contracts.js';

const invalid = (): never => { throw new StoreError('STORE_INVALID','Invalid retention request.'); };
const time = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) invalid(); };
export const utcDay = (now: number): string => new Date(now).toISOString().slice(0,10);
/** Pseudonymous key for a removed identity; it is kept only until its UTC start day has passed. */
export const identityHash = (provider: string, subject: string): string => createHash('sha256').update(`${provider}:${subject}`).digest('hex');

/**
 * Methods run inside the worker's BEGIN IMMEDIATE transaction.
 * provider_calls is deliberately never touched here: it has no owner column, it carries
 * known spend and unresolved liabilities, and pruning it before a durable cumulative
 * ledger exists would turn cleanup into a budget refill.
 */
export class RetentionRepository {
  constructor(private db: DatabaseSync) {}
  private removeAttempt(id: string): void {
    this.db.prepare('DELETE FROM start_receipts WHERE attempt_id=?').run(id);
    // reports, receipts and phase_jobs cascade from the attempt.
    this.db.prepare('DELETE FROM attempts WHERE id=?').run(id);
  }
  sweep(input: StoreOperations['sweepRetention']['input']): StoreOperations['sweepRetention']['output'] {
    for (const n of [input.now,input.resultBefore,input.diagnosticBefore]) time(n);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500 || input.resultBefore > input.diagnosticBefore || input.diagnosticBefore > input.now) invalid();
    // Only closed attempts age out; an ACTIVE attempt is never retention's to remove.
    const expired = this.db.prepare("SELECT id FROM attempts WHERE lifecycle<>'ACTIVE' AND updated_at<=? ORDER BY updated_at,id LIMIT ?").all(input.resultBefore,input.limit);
    for (const row of expired) this.removeAttempt(String(row.id));
    const stale = this.db.prepare(`SELECT a.id FROM attempts a WHERE a.lifecycle<>'ACTIVE' AND a.updated_at<=?
      AND (EXISTS(SELECT 1 FROM phase_jobs j WHERE j.attempt_id=a.id) OR EXISTS(SELECT 1 FROM receipts r WHERE r.attempt_id=a.id))
      ORDER BY a.updated_at,a.id LIMIT ?`).all(input.diagnosticBefore,input.limit);
    for (const row of stale) {
      this.db.prepare('DELETE FROM phase_jobs WHERE attempt_id=?').run(row.id);
      this.db.prepare('DELETE FROM receipts WHERE attempt_id=?').run(row.id);
    }
    const sessions = Number(this.db.prepare(`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions
      WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?) LIMIT ?)`).run(input.diagnosticBefore,input.diagnosticBefore,input.limit).changes);
    // A daily counter only limits its own UTC day, so removing a past day never restores a start.
    this.db.prepare('DELETE FROM account_starts WHERE utc_day<?').run(utcDay(input.now));
    this.db.prepare('DELETE FROM deleted_identities WHERE utc_day<?').run(utcDay(input.now));
    this.db.prepare("DELETE FROM outbox WHERE state IN ('SENT','FAILED') AND created_at<=?").run(input.diagnosticBefore);
    // Finished exhibition games age out with other results; an unfinished one is kept.
    this.db.prepare("DELETE FROM exhibitions WHERE state NOT IN ('RUNNING','PAUSED') AND updated_at<=?").run(input.resultBefore);
    this.db.prepare('DELETE FROM operator_audit WHERE at<=?').run(input.resultBefore);
    // Detailed receipts go only once their cost is in the ledger (settled) or provably nil (released).
    // A held reservation and its call are never pruned, however old.
    let receipts = 0;
    if (input.receiptBefore !== undefined) {
      time(input.receiptBefore);
      if (input.receiptBefore > input.now) invalid();
      const closed = this.db.prepare(`SELECT r.call_id FROM reservations r WHERE r.state<>'HELD' AND r.closed_at<=? ORDER BY r.closed_at LIMIT ?`).all(input.receiptBefore,input.limit);
      for (const row of closed) {
        this.db.prepare('DELETE FROM provider_calls WHERE id=?').run(row.call_id);
        this.db.prepare('DELETE FROM reservations WHERE call_id=?').run(row.call_id);
      }
      receipts = closed.length;
      // Per-attempt totals are only needed while the attempt can still spend.
      this.db.prepare(`DELETE FROM attempt_spend WHERE attempt_id NOT IN (SELECT id FROM attempts) AND attempt_id NOT IN (SELECT attempt_id FROM reservations)`).run();
    }
    return { attempts: expired.length, diagnostics: stale.length, sessions, receipts, more: [expired.length,stale.length,sessions,receipts].includes(input.limit) };
  }
  deleteAccount(input: StoreOperations['deleteAccount']['input']): StoreOperations['deleteAccount']['output'] {
    time(input.now);
    const player = this.db.prepare('SELECT provider,subject,banned_at FROM players WHERE id=?').get(input.playerId);
    // A ban must outlive the account that earned it, so a banned identity cannot be erased and re-created.
    if (!player || player.banned_at !== null) throw new StoreError('STORE_FORBIDDEN','This account cannot be deleted.');
    const day = utcDay(input.now);
    const accepted = Number(this.db.prepare('SELECT accepted FROM account_starts WHERE player_id=? AND utc_day=?').get(input.playerId,day)?.accepted ?? 0);
    // Deleting and signing in again must not refill today's start allowance.
    if (accepted > 0) this.db.prepare(`INSERT INTO deleted_identities(identity_hash,utc_day,accepted,deleted_at) VALUES(?,?,?,?)
      ON CONFLICT(identity_hash) DO UPDATE SET accepted=CASE WHEN utc_day=excluded.utc_day THEN MAX(accepted,excluded.accepted) ELSE excluded.accepted END,
      utc_day=excluded.utc_day,deleted_at=excluded.deleted_at`).run(identityHash(String(player.provider),String(player.subject)),day,accepted,input.now);
    const sessions = this.db.prepare('SELECT token_hash FROM sessions WHERE player_id=?').all(input.playerId).map(r => String(r.token_hash));
    const attempts = this.db.prepare('SELECT id FROM attempts WHERE player_id=?').all(input.playerId);
    for (const row of attempts) this.removeAttempt(String(row.id));
    for (const table of ['account_starts','sessions']) this.db.prepare(`DELETE FROM ${table} WHERE player_id=?`).run(input.playerId);
    this.db.prepare('DELETE FROM players WHERE id=?').run(input.playerId);
    return { sessions, attempts: attempts.length };
  }
  /** Called while a new player row is created for an identity deleted earlier the same UTC day. */
  restoreStarts(playerId: string, provider: string, subject: string, now: number): void {
    const prior = this.db.prepare('SELECT utc_day,accepted FROM deleted_identities WHERE identity_hash=?').get(identityHash(provider,subject));
    if (prior && prior.utc_day === utcDay(now)) this.db.prepare('INSERT INTO account_starts(player_id,utc_day,accepted) VALUES(?,?,?)').run(playerId,utcDay(now),prior.accepted);
  }
}
