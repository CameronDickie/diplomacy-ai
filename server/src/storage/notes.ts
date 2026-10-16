import type { DatabaseSync } from 'node:sqlite';
import type { Power } from '@diplomacy/shared';
import { StoreError, type StoreOperations } from './contracts.js';

export interface StoredPowerNote { callId: string; attemptId: string; phaseId: string; power: Power; note: string; createdAt: number }
export const NOTE_LIMIT = 400;
const invalid = (): never => { throw new StoreError('STORE_INVALID','Invalid power note.'); };
const conflict = (): never => { throw new StoreError('STORE_CONFLICT','This note no longer belongs to a live phase.'); };

/**
 * The private notes model-played powers write to themselves with their orders in a full game: plans,
 * promises made and received, who kept theirs. One row per paid orders call, written once its billed
 * answer has been checked, so a continued phase never loses or doubles a note. Only that power is shown it.
 */
export class NoteRepository {
  constructor(private db: DatabaseSync) {}
  list(attemptId: string): StoredPowerNote[] {
    if (typeof attemptId !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(attemptId)) invalid();
    return this.db.prepare('SELECT * FROM power_notes WHERE attempt_id=? ORDER BY created_at,rowid LIMIT 50000').all(attemptId).map(r => ({ callId: String(r.call_id),
      attemptId: String(r.attempt_id), phaseId: String(r.phase_id), power: r.power as Power, note: String(r.note), createdAt: Number(r.created_at) }));
  }
  save(input: StoreOperations['savePowerNote']['input']): null {
    if (typeof input.callId !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(input.callId) || !Number.isSafeInteger(input.now)) invalid();
    const note = typeof input.note === 'string' ? input.note.replace(/\s+/g,' ').trim() : '';
    if (!note || note.length > NOTE_LIMIT) invalid();
    const call = this.db.prepare('SELECT intent_json,state,outcome,received_at FROM provider_calls WHERE id=?').get(input.callId);
    if (!call) conflict();
    const intent = JSON.parse(String(call!.intent_json)) as { role: string; power: Power; fence: { operationId: string; attemptId: string; phaseId: string; revision: number } };
    if (intent.role !== 'ORDERS') invalid();
    const old = this.db.prepare('SELECT note FROM power_notes WHERE call_id=?').get(input.callId);
    if (old) { if (String(old.note) !== note) conflict(); return null; }
    // Only a billed, not yet closed answer of a phase that is still being decided may add a note.
    if (call!.received_at === null || call!.outcome !== null || call!.state !== 'RECEIVED') conflict();
    const f = intent.fence;
    const live = this.db.prepare(`SELECT 1 FROM phase_jobs j JOIN attempts a ON a.id=j.attempt_id JOIN players p ON p.id=a.player_id
      WHERE j.id=? AND j.attempt_id=? AND j.phase_id=? AND j.revision=? AND a.revision=j.revision AND a.phase_id=j.phase_id
      AND j.status IN ('DECIDING','RECOVERING') AND a.lifecycle='ACTIVE' AND p.banned_at IS NULL`).get(f.operationId,f.attemptId,f.phaseId,f.revision);
    if (!live) conflict();
    this.db.prepare('INSERT INTO power_notes(call_id,attempt_id,phase_id,power,note,created_at) VALUES(?,?,?,?,?,?)').run(input.callId,f.attemptId,f.phaseId,intent.power,note,input.now);
    return null;
  }
}
