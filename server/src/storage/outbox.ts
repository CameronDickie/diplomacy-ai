import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { StoreError, type OutboxKind, type OutboxMessage, type StoreOperations } from './contracts.js';

const invalid = (): never => { throw new StoreError('STORE_INVALID','Invalid notification request.'); };
const time = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) invalid(); };
export const OUTBOX_MAX_ATTEMPTS = 8;
/** 1, 2, 4 … minutes, capped at one hour. */
export const outboxBackoffMs = (attempts: number): number => Math.min(60, 2 ** Math.max(0,attempts-1)) * 60_000;

/** Methods run inside the worker transaction. Delivery is at-least-once; `dedupeKey` makes it one logical message. */
export class OutboxRepository {
  constructor(private db: DatabaseSync) {}
  private message(r: Record<string, unknown>): OutboxMessage {
    return { id:Number(r.id), dedupeKey:String(r.dedupe_key), kind:r.kind as OutboxKind, payload:JSON.parse(String(r.payload_json)), state:r.state as OutboxMessage['state'],
      attempts:Number(r.attempts), nextAttemptAt:Number(r.next_attempt_at), createdAt:Number(r.created_at), sentAt:r.sent_at===null?null:Number(r.sent_at),
      channel:r.channel===null?null:r.channel as OutboxMessage['channel'], lastError:r.last_error===null?null:String(r.last_error) };
  }
  /** Returns false when the same logical event was already recorded. */
  enqueue(kind: OutboxKind, dedupeKey: string, payload: Record<string,string|number|null>, now: number): boolean {
    time(now);
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(dedupeKey)) invalid();
    return this.db.prepare(`INSERT INTO outbox(dedupe_key,kind,payload_json,state,next_attempt_at,created_at) VALUES(?,?,?,'PENDING',?,?)
      ON CONFLICT(dedupe_key) DO NOTHING`).run(dedupeKey,kind,canonicalJson(payload),now,now).changes === 1;
  }
  /** A claim is a lease: a sender that dies leaves the row due again after `leaseMs`. */
  claim(input: StoreOperations['claimOutbox']['input']): OutboxMessage[] {
    time(input.now);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20 || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > 600_000) invalid();
    const rows = this.db.prepare("SELECT * FROM outbox WHERE state IN ('PENDING','SENDING') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?").all(input.now,input.limit);
    for (const row of rows) this.db.prepare("UPDATE outbox SET state='SENDING',attempts=attempts+1,next_attempt_at=? WHERE id=?").run(input.now+input.leaseMs,row.id);
    return rows.map(r => this.message({...r,state:'SENDING',attempts:Number(r.attempts)+1}));
  }
  settle(input: StoreOperations['settleOutbox']['input']): OutboxMessage {
    time(input.now);
    const row = this.db.prepare('SELECT * FROM outbox WHERE id=?').get(input.id);
    if (!row) throw new StoreError('STORE_CONFLICT','Notification no longer exists.');
    // A late result for a message that was already delivered must not reopen it.
    if (row.state === 'SENT' || row.state === 'FAILED') return this.message(row);
    if (input.ok) {
      if (!['outbox','resend'].includes(input.channel)) invalid();
      this.db.prepare("UPDATE outbox SET state='SENT',sent_at=?,channel=?,last_error=NULL WHERE id=?").run(input.now,input.channel,input.id);
    } else {
      const error = typeof input.error === 'string' && /^[A-Z0-9_]{1,40}$/.test(input.error) ? input.error : 'DELIVERY_FAILED';
      const exhausted = Number(row.attempts) >= OUTBOX_MAX_ATTEMPTS;
      this.db.prepare('UPDATE outbox SET state=?,next_attempt_at=?,last_error=? WHERE id=?').run(exhausted?'FAILED':'PENDING',input.now+outboxBackoffMs(Number(row.attempts)),error,input.id);
    }
    return this.message(this.db.prepare('SELECT * FROM outbox WHERE id=?').get(input.id)!);
  }
  recent(limit: number): OutboxMessage[] { return this.db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT ?').all(limit).map(r => this.message(r)); }
  counts(): Record<OutboxMessage['state'],number> {
    const result = {PENDING:0,SENDING:0,SENT:0,FAILED:0};
    for (const r of this.db.prepare('SELECT state,count(*) n FROM outbox GROUP BY state').all()) result[r.state as OutboxMessage['state']] = Number(r.n);
    return result;
  }
}
