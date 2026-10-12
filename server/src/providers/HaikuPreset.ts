import { createHash } from 'node:crypto';
import { ASK_INSTRUCTIONS, CHAT_INSTRUCTIONS, FULL_GAME_INSTRUCTIONS, FULL_GAME_UNIT_INSTRUCTIONS, OPPONENT_INSTRUCTIONS, REPLY_INSTRUCTIONS } from './OpponentInstructions.js';
import { FULL_GAME_REQUEST_KINDS, type FullGameRequestKind } from './LunaPreset.js';

/** Version the whole contract whenever settings, schema or prices change. */
export const HAIKU_PRESET = Object.freeze({
  id: 'haiku-challenge-v4', provider: 'ANTHROPIC', model: 'claude-haiku-5-5', pricingVersion: 'haiku-5-5-standard-2026-10-08',
  serviceTier: 'standard', effort: 'low',
  // Thinking is always billed as output and counts toward max_tokens, so the cap is the worst case.
  maxInputTokens: 32_768, maxOutputTokens: 4_096,
  maxContextBytes: 24_000, maxRequestBytes: 32_768, maxResponseBytes: 256 * 1024,
  countTimeoutMs: 5_000, timeoutMs: 20_000, retries: 0,
  maxConcurrentDecisions: 6,
  // Integer USD nanodollars per token, for prompts of at most 100,000 tokens. Thinking is included in output.
  inputNanousd: 100, cachedInputNanousd: 10, cacheWrite5mNanousd: 125, cacheWrite1hNanousd: 200, outputNanousd: 500,
  // A longer prompt is billed on a second rate card. The input bound keeps requests far below it.
  longPromptTokens: 100_000, longPromptMultiplier: 5,
} as const);

const instructions = OPPONENT_INSTRUCTIONS;

/**
 * Only server-built game context enters the request; no model, tools, sampling or fallback overrides.
 * No `cache_control` is sent, so nothing is written to a prompt cache, and no `fallbacks`: this model
 * has no server-side fallback and another model's rates must never apply to a reserved call.
 * The schema carries no numeric or length limits (the API rejects them); indices are bounded when parsed.
 */
export function buildHaikuRequest(input: { context: string }) { return build(input,instructions,ORDERS_SCHEMA); }
/** The same pinned settings, asking for one short reply to the player instead of a set of choices. */
export function buildHaikuChatRequest(input: { context: string }) { return build(input,CHAT_INSTRUCTIONS,REPLY_SCHEMA); }
const ORDERS_SCHEMA = { type: 'object', properties: { choices: { type: 'array', items: { type: 'integer' } } },
  required: ['choices'], additionalProperties: false } as const;
const REPLY_SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false } as const;
const MESSAGES_SCHEMA = { type: 'object', properties: { messages: { type: 'array',
  items: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'], additionalProperties: false } } },
  required: ['messages'], additionalProperties: false } as const;
/** The three pinned requests of a model-only full game: its orders, its opening messages, its replies. Development only. */
const UNIT_ORDERS_SCHEMA = { type: 'object', properties: { orders: { type: 'array',
  items: { type: 'object', properties: { unit: { type: 'string' }, choice: { type: 'integer' } }, required: ['unit', 'choice'], additionalProperties: false } } },
  required: ['orders'], additionalProperties: false } as const;
export function buildHaikuFullGameRequest(input: { context: string }, kind: FullGameRequestKind) {
  if (kind === 'UNIT_ORDERS') return build(input,FULL_GAME_UNIT_INSTRUCTIONS,UNIT_ORDERS_SCHEMA);
  return kind === 'ORDERS' ? build(input,FULL_GAME_INSTRUCTIONS,ORDERS_SCHEMA) : build(input,kind === 'ASK' ? ASK_INSTRUCTIONS : REPLY_INSTRUCTIONS,MESSAGES_SCHEMA);
}
/** Every serialized request this preset may send for a context. A transport refuses anything else. */
export const haikuRequestBodies = (input: { context: string }): string[] =>
  [buildHaikuRequest(input).body, buildHaikuChatRequest(input).body, ...FULL_GAME_REQUEST_KINDS.map(kind => buildHaikuFullGameRequest(input,kind).body)];
function build(input: { context: string }, system: string, schema: typeof ORDERS_SCHEMA | typeof REPLY_SCHEMA | typeof MESSAGES_SCHEMA | typeof UNIT_ORDERS_SCHEMA) {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'context')
    || typeof input.context !== 'string' || !input.context.trim()
    || Buffer.byteLength(input.context, 'utf8') > HAIKU_PRESET.maxContextBytes) {
    throw new Error('Invalid or oversized Haiku context.');
  }
  const body = JSON.stringify({
    model: HAIKU_PRESET.model, max_tokens: HAIKU_PRESET.maxOutputTokens, stream: false,
    thinking: { type: 'adaptive' },
    output_config: { effort: HAIKU_PRESET.effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: input.context }],
  });
  // Serialized bytes are immutable, so later mutation cannot invalidate a reserved hash.
  return Object.freeze({ body, requestHash: createHash('sha256').update(body).digest('hex'),
    presetId: HAIKU_PRESET.id, pricingVersion: HAIKU_PRESET.pricingVersion });
}

/** Requires a verified input count/bound for this exact serialized request, NOT chars/4. */
export function haikuReservationNanousd(inputTokens: number): number {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens > HAIKU_PRESET.maxInputTokens) {
    throw new Error('Haiku input token bound is unavailable or exceeds the preset.');
  }
  // Never assume a cache hit; the dearest input rate is a one-hour cache write.
  return inputTokens * HAIKU_PRESET.cacheWrite1hNanousd + HAIKU_PRESET.maxOutputTokens * HAIKU_PRESET.outputNanousd;
}

export const haikuContextOf = (body: string): string => String(JSON.parse(body).messages[0].content);

export function mockHaikuEnvelope({ serial, text, inputTokens, outputTokens }: { serial: number; text: string; inputTokens: number; outputTokens: number }): unknown {
  return { id: `msg_mock_${serial}_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: HAIKU_PRESET.model,
    // A real answer begins with a thinking block whose text is omitted.
    content: [{ type: 'thinking', thinking: '', signature: 'mock' }, { type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 16 },
      server_tool_use: null, service_tier: HAIKU_PRESET.serviceTier } };
}
