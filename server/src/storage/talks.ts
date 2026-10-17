import type { DatabaseSync } from 'node:sqlite';
import { ALL_POWERS, type Power } from '@diplomacy/shared';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { StoreError, type StoreOperations } from './contracts.js';

export interface StoredPowerTalk {
  callId: string; attemptId: string; operationId: string; phaseId: string;
  /** ASK: messages this power chose to send. REPLY: its answers to powers that wrote to it this phase. */
  kind: 'ASK' | 'REPLY'; power: Power; messages: Array<{ to: Power; body: string }>; createdAt: number;
}
export const TALK_BODY_LIMIT = 500;
export const TALK_MESSAGE_LIMIT = 6;
const invalid = (): never => { throw new StoreError('STORE_INVALID','Invalid power messages.'); };
const conflict = (): never => { throw new StoreError('STORE_CONFLICT','These messages no longer belong to a live phase.'); };
const identifier = (s: unknown) => { if (typeof s !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(s)) invalid(); };

/**
 * Messages between model-played powers in a full game with no human. One row per paid call, written
 * as soon as its billed answer has been checked, so an interrupted phase never buys the same
 * messages twice. A row with no messages records that the power chose to stay silent.
 */
export class TalkRepository {
  constructor(private db: DatabaseSync) {}
  list(attemptId: string): StoredPowerTalk[] {
    identifier(attemptId);
    return this.db.prepare('SELECT * FROM power_talks WHERE attempt_id=? ORDER BY created_at,rowid LIMIT 50000').all(attemptId).map(r => ({ callId: String(r.call_id), attemptId: String(r.attempt_id),
      operationId: String(r.operation_id), phaseId: String(r.phase_id), kind: r.kind as StoredPowerTalk['kind'], power: r.power as Power,
      messages: JSON.parse(String(r.messages_json)) as StoredPowerTalk['messages'], createdAt: Number(r.created_at) }));
  }
  /**
   * A person's messages, kept beside the models' so every later request shows them the same way. Their row
   * is named `human:<phase operation>:<power>` and is written once; there is no call to bill.
   */
  saveHuman(input: StoreOperations['saveHumanTalk']['input']): null {
    identifier(input.attemptId); identifier(input.operationId);
    if (typeof input.phaseId !== 'string' || input.phaseId.length > 200 || !ALL_POWERS.includes(input.power) || !Number.isSafeInteger(input.now)
      || !Array.isArray(input.messages) || input.messages.length > TALK_MESSAGE_LIMIT) invalid();
    const messages = input.messages.map(m => {
      const body = typeof m?.body === 'string' ? m.body.replace(/\s+/g,' ').trim() : '';
      if (!m || !ALL_POWERS.includes(m.to) || m.to === input.power || !body || body.length > TALK_BODY_LIMIT) invalid();
      return { to: m.to, body };
    });
    if (new Set(messages.map(m => m.to)).size !== messages.length) invalid();
    const callId = `human:${input.operationId}:${input.power}`;
    const old = this.db.prepare('SELECT messages_json FROM power_talks WHERE call_id=?').get(callId);
    if (old) { if (String(old.messages_json) !== canonicalJson(messages)) conflict(); return null; }
    const live = this.db.prepare(`SELECT 1 FROM phase_jobs j JOIN attempts a ON a.id=j.attempt_id WHERE j.id=? AND j.attempt_id=? AND j.phase_id=?
      AND a.phase_id=j.phase_id AND j.status IN ('DECIDING','RECOVERING') AND a.lifecycle='ACTIVE'`).get(input.operationId,input.attemptId,input.phaseId);
    if (!live) conflict();
    this.db.prepare('INSERT INTO power_talks(call_id,attempt_id,operation_id,phase_id,kind,power,messages_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(callId,input.attemptId,input.operationId,input.phaseId,'ASK',input.power,canonicalJson(messages),input.now);
    return null;
  }
  save(input: StoreOperations['savePowerTalk']['input']): null {
    identifier(input.callId);
    if (!Number.isSafeInteger(input.now) || !Array.isArray(input.messages) || input.messages.length > TALK_MESSAGE_LIMIT) invalid();
    const call = this.db.prepare('SELECT intent_json,state,outcome,received_at FROM provider_calls WHERE id=?').get(input.callId);
    if (!call) conflict();
    const intent = JSON.parse(String(call!.intent_json)) as { role: string; power: Power; fence: { operationId: string; attemptId: string; phaseId: string; revision: number } };
    if (intent.role !== 'ASK' && intent.role !== 'REPLY') invalid();
    const messages = input.messages.map(m => {
      const body = typeof m?.body === 'string' ? m.body.trim() : '';
      if (!m || !ALL_POWERS.includes(m.to) || m.to === intent.power || !body || body.length > TALK_BODY_LIMIT) invalid();
      return { to: m.to, body };
    });
    if (new Set(messages.map(m => m.to)).size !== messages.length) invalid();
    const old = this.db.prepare('SELECT messages_json FROM power_talks WHERE call_id=?').get(input.callId);
    if (old) { if (String(old.messages_json) !== canonicalJson(messages)) conflict(); return null; }
    // Only a billed, not yet closed answer of a phase that is still being decided may add messages.
    if (call!.received_at === null || call!.outcome !== null || call!.state !== 'RECEIVED') conflict();
    const f = intent.fence;
    const live = this.db.prepare(`SELECT 1 FROM phase_jobs j JOIN attempts a ON a.id=j.attempt_id JOIN players p ON p.id=a.player_id
      WHERE j.id=? AND j.attempt_id=? AND j.phase_id=? AND j.revision=? AND a.revision=j.revision AND a.phase_id=j.phase_id
      AND j.status IN ('DECIDING','RECOVERING') AND a.lifecycle='ACTIVE' AND p.banned_at IS NULL`).get(f.operationId,f.attemptId,f.phaseId,f.revision);
    if (!live) conflict();
    this.db.prepare('INSERT INTO power_talks(call_id,attempt_id,operation_id,phase_id,kind,power,messages_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(input.callId,f.attemptId,f.operationId,f.phaseId,intent.role,intent.power,canonicalJson(messages),input.now);
    return null;
  }
}
