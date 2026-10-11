import type { DatabaseSync } from 'node:sqlite';
import { ALL_POWERS, type Power } from '@diplomacy/shared';
import { StoreError, type StoreOperations } from './contracts.js';

export interface StoredChatMessage {
  id: string; attemptId: string; power: Power; sender: 'PLAYER' | 'OPPONENT'; body: string;
  /** For a player's message: whether the opponent's reply is still being produced, arrived or failed. */
  replyState: 'PENDING' | 'COMPLETE' | 'FAILED' | null;
  phaseId: string; revision: number; createdAt: number;
}
export const CHAT_BODY_LIMIT = 500;
const invalid = (message = 'Invalid chat message.'): never => { throw new StoreError('STORE_INVALID',message); };
const conflict = (message: string): never => { throw new StoreError('STORE_CONFLICT',message); };
const identifier = (s: unknown) => { if (typeof s !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(s)) invalid(); };
const row = (r: Record<string, unknown>): StoredChatMessage => ({ id: String(r.id), attemptId: String(r.attempt_id), power: r.power as Power, sender: r.sender as StoredChatMessage['sender'],
  body: String(r.body), replyState: r.reply_state as StoredChatMessage['replyState'], phaseId: String(r.phase_id), revision: Number(r.revision), createdAt: Number(r.created_at) });

/**
 * Private one-to-one conversations between the player and each opponent power, per attempt.
 * Methods run inside the worker transaction. A player's message is stored at most once per
 * request id and admits at most one reply; the paid call for that reply is fenced to the message.
 */
export class ChatRepository {
  constructor(private db: DatabaseSync) {}
  list(attemptId: string): StoredChatMessage[] {
    identifier(attemptId);
    return this.db.prepare('SELECT * FROM chat_messages WHERE attempt_id=? ORDER BY created_at,rowid').all(attemptId).map(r => row(r as Record<string, unknown>));
  }
  send(input: StoreOperations['chatSend']['input']): StoreOperations['chatSend']['output'] {
    for (const id of [input.id,input.attemptId,input.playerId,input.requestId]) identifier(id);
    if (!ALL_POWERS.includes(input.power) || !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) invalid();
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (!body || body.length > CHAT_BODY_LIMIT) invalid(`A message is 1 to ${CHAT_BODY_LIMIT} characters.`);
    const attempt = this.db.prepare(`SELECT a.player_id,a.lifecycle,a.execution,a.opponents,a.phase_id,a.revision,json_extract(a.board_json,'$.phase') phase,c.definition_json
      FROM attempts a JOIN challenges c ON c.id=a.challenge_id AND c.version=a.challenge_version WHERE a.id=?`).get(input.attemptId);
    if (!attempt || attempt.player_id !== input.playerId) throw new StoreError('STORE_FORBIDDEN','Attempt is unavailable.');
    const existing = this.db.prepare('SELECT * FROM chat_messages WHERE attempt_id=? AND request_id=?').get(input.attemptId,input.requestId);
    if (existing) {
      // The same request is the same message; a reused id with different content is refused, never stored twice.
      if (existing.power !== input.power || existing.body !== body) conflict('That message id was already used for a different message.');
      return { message: row(existing as Record<string, unknown>), duplicate: true, used: this.used(input.attemptId) };
    }
    const definition = JSON.parse(String(attempt.definition_json)) as { opponentPowers: Power[] };
    if (attempt.opponents !== 'LUNA' || !definition.opponentPowers.includes(input.power)) invalid('That power cannot be messaged in this attempt.');
    if (attempt.lifecycle !== 'ACTIVE' || attempt.execution !== 'ACCEPTING' || attempt.phase !== 'ORDERS') conflict('Messages can be sent while you are choosing orders.');
    if (this.db.prepare("SELECT 1 FROM chat_messages WHERE attempt_id=? AND power=? AND reply_state='PENDING' AND created_at>?").get(input.attemptId,input.power,input.now - 60_000))
      conflict('That power is still replying to your last message.');
    const used = this.used(input.attemptId);
    if (used >= input.limit) throw new StoreError('CHAT_LIMIT','You have used every message for this attempt.');
    this.db.prepare(`INSERT INTO chat_messages(id,attempt_id,power,sender,request_id,body,reply_state,phase_id,revision,created_at) VALUES(?,?,?,'PLAYER',?,?,'PENDING',?,?,?)`)
      .run(input.id,input.attemptId,input.power,input.requestId,body,String(attempt.phase_id),Number(attempt.revision),input.now);
    return { message: row(this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(input.id) as Record<string, unknown>), duplicate: false, used: used + 1 };
  }
  private used(attemptId: string): number {
    return Number(this.db.prepare("SELECT count(*) n FROM chat_messages WHERE attempt_id=? AND sender='PLAYER'").get(attemptId)!.n);
  }
  /** Stores the opponent's reply and marks the player's message answered. A message is answered at most once. */
  reply(input: StoreOperations['chatReply']['input']): StoredChatMessage {
    identifier(input.messageId);
    const body = typeof input.body === 'string' ? input.body.trim().slice(0,2000) : '';
    if (!body || !Number.isSafeInteger(input.now)) invalid();
    const asked = this.db.prepare("SELECT * FROM chat_messages WHERE id=? AND sender='PLAYER'").get(input.messageId);
    if (!asked || asked.reply_state !== 'PENDING') conflict('That message is not awaiting a reply.');
    this.db.prepare("UPDATE chat_messages SET reply_state='COMPLETE' WHERE id=?").run(input.messageId);
    const id = `${input.messageId}:reply`;
    this.db.prepare(`INSERT INTO chat_messages(id,attempt_id,power,sender,request_id,body,reply_state,phase_id,revision,created_at) VALUES(?,?,?,'OPPONENT',NULL,?,NULL,?,?,?)`)
      .run(id,String(asked!.attempt_id),String(asked!.power),body,String(asked!.phase_id),Number(asked!.revision),input.now);
    return row(this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(id) as Record<string, unknown>);
  }
  /** The reply could not be produced. The player's message stays, visibly unanswered. */
  fail(input: StoreOperations['chatFail']['input']): void {
    identifier(input.messageId);
    this.db.prepare("UPDATE chat_messages SET reply_state='FAILED' WHERE id=? AND reply_state='PENDING'").run(input.messageId);
  }
}
