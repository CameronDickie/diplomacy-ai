import { randomUUID } from 'node:crypto';
import type { ChatMessageView, ChatView, Power } from '@diplomacy/shared';
import { chatPrompt } from '../luna/Context.js';
import type { LunaTransport } from '../luna/Transport.js';
import type { ProviderCallIntent } from '../providers/accounting.js';
import type { OpponentContract } from '../providers/OpponentContract.js';
import type { OpponentPlan } from '../providers/OpponentPlan.js';
import { recordedCall } from '../providers/RecordedCall.js';
import { CHAT_BODY_LIMIT, type StoredChatMessage } from '../storage/chat.js';
import { StoreError } from '../storage/contracts.js';
import type { Store } from '../storage/Store.js';
import type { StoredAttempt, StoredChallenge } from '../storage/contracts.js';

/** A reply that never arrived stops counting as "still replying" after this long. */
const STALE_MS = 60_000;
const REPLY_LIMIT = 700;

/**
 * The player's private conversations with opponent powers. A message is stored first; its reply is
 * one reserved, recorded call to that power's own pinned model, through the same ledger as an
 * order decision. Opponents only ever reply: they do not start conversations or talk to each other.
 */
export class OpponentChat {
  constructor(private store: Store, private plan: OpponentPlan, private transportFor: (contract: OpponentContract) => LunaTransport,
    private options: { limit: number; now: () => number }) {}

  async view(attempt: StoredAttempt): Promise<ChatView> {
    const now = this.options.now(), messages = await this.store.call('chatMessages',{ attemptId: attempt.id });
    return { limit: this.options.limit, used: messages.filter(m => m.sender === 'PLAYER').length, maxLength: CHAT_BODY_LIMIT,
      canSend: attempt.mode === 'SPONSORED' && attempt.lifecycle === 'ACTIVE' && attempt.execution === 'ACCEPTING' && attempt.board.phase === 'ORDERS',
      messages: messages.map((m): ChatMessageView => ({ id: m.id, power: m.power, from: m.sender, body: m.body, at: m.createdAt,
        // A reply that was interrupted (for example by a restart) is shown as failed, not as still coming.
        reply: m.replyState === 'PENDING' && now - m.createdAt > STALE_MS ? 'FAILED' : m.replyState })) };
  }

  /** Stores the message (once per request id) and, for a new one, obtains and stores the reply. */
  async send(attempt: StoredAttempt, challenge: StoredChallenge, input: { power: Power; requestId: string; body: string }): Promise<void> {
    const now = this.options.now();
    const sent = await this.store.call('chatSend',{ id: `chat-${randomUUID()}`, attemptId: attempt.id, playerId: attempt.playerId, power: input.power,
      requestId: input.requestId, body: input.body, limit: this.options.limit, now });
    // A repeated request stores nothing and buys nothing: the first delivery owns the reply.
    if (sent.duplicate) return;
    try { await this.reply(attempt,challenge,sent.message); }
    catch { await this.store.call('chatFail',{ messageId: sent.message.id, now: this.options.now() }).catch(() => {}); }
  }

  private async reply(attempt: StoredAttempt, challenge: StoredChallenge, asked: StoredChatMessage): Promise<void> {
    const contract = this.plan.contractFor(asked.power), now = this.options.now;
    const [reports, all] = await Promise.all([this.store.call('reports',{ attemptId: attempt.id }),this.store.call('chatMessages',{ attemptId: attempt.id })]);
    const thread = all.filter(m => m.power === asked.power && m.createdAt <= asked.createdAt);
    const prompt = chatPrompt({ board: attempt.board, definition: challenge.definition },asked.power,reports.at(-1) ?? null,thread,contract);
    const intent: ProviderCallIntent = { id: `${asked.id}:call`, fence: { operationId: asked.id, attemptId: attempt.id, phaseId: asked.phaseId, revision: asked.revision },
      power: asked.power, provider: contract.preset.provider, model: contract.preset.model, role: 'CHAT',
      pricingVersion: prompt.request.pricingVersion, requestHash: prompt.request.requestHash, maxCostNanousd: prompt.maxCostNanousd };
    await this.store.call('prepareProviderCall',{ intent, now: now() });
    const signal = AbortSignal.timeout(contract.preset.timeoutMs + 10_000);
    let transport = this.transportFor(contract);
    if (transport.preflight) {
      try { transport = (await transport.preflight({ body: prompt.request.body, signal })).send; }
      catch (error) { await this.store.call('releaseProviderCall',{ id: intent.id, now: now() }).catch(() => {}); throw error; }
    }
    const text = await recordedCall({ store: this.store, id: intent.id, signal, timeoutMs: contract.preset.timeoutMs, now,
      transport: async s => { const response = await transport({ body: prompt.request.body, signal: s }); return contract.normalizeResponse(response.body,response.status); },
      validate: parsed => {
        const reply = (parsed as { reply?: unknown } | null)?.reply;
        if (typeof reply !== 'string' || !reply.trim()) throw new StoreError('STORE_INVALID','The reply was empty.');
        return reply.trim().slice(0,REPLY_LIMIT);
      } });
    await this.store.call('chatReply',{ messageId: asked.id, body: text, now: now() });
  }
}
