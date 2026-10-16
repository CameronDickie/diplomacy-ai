import { createHash } from 'node:crypto';
import { ASK_INSTRUCTIONS, CHAT_INSTRUCTIONS, FULL_GAME_INSTRUCTIONS, FULL_GAME_UNIT_INSTRUCTIONS, OPPONENT_INSTRUCTIONS, REPLY_INSTRUCTIONS } from './OpponentInstructions.js';

/** Version the whole contract whenever settings, schema or prices change. */
export const LUNA_PRESET = Object.freeze({
  id: 'luna-challenge-v5', model: 'gpt-6-luna', pricingVersion: 'luna-standard-2026-10-07',
  endpoint: 'https://api.openai.com/v1/responses', serviceTier: 'default',
  reasoningEffort: 'low', maxInputTokens: 32_768, maxOutputTokens: 2_048,
  maxContextBytes: 24_000, maxRequestBytes: 32_768, maxResponseBytes: 256 * 1024,
  countEndpoint: 'https://api.openai.com/v1/responses/input_tokens', countTimeoutMs: 5_000,
  maxCountResponseBytes: 4_096, timeoutMs: 20_000, retries: 0,
  maxConcurrentDecisions: 6,
  // Integer USD nanodollars per token; reasoning is already included in output.
  inputNanousd: 100, cachedInputNanousd: 10, cacheWriteNanousd: 125, outputNanousd: 500,
} as const);

const instructions = OPPONENT_INSTRUCTIONS;

/** Only server-built game context enters the request; no model, role, tier or tools overrides. */
export function buildLunaRequest(input: { context: string }) { return build(input,instructions,ORDERS_FORMAT); }
/** The same pinned settings, asking for one short reply to the player instead of a set of choices. */
export function buildLunaChatRequest(input: { context: string }) { return build(input,CHAT_INSTRUCTIONS,REPLY_FORMAT); }
const ORDERS_FORMAT = { type: 'json_schema', name: 'diplomacy_choices', strict: true,
  schema: { type: 'object', properties: { choices: { type: 'array', maxItems: 34,
    items: { type: 'integer', minimum: 0, maximum: 100_000 } } },
  required: ['choices'], additionalProperties: false } } as const;
const REPLY_FORMAT = { type: 'json_schema', name: 'diplomacy_reply', strict: true,
  schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false } } as const;
const MESSAGES_FORMAT = { type: 'json_schema', name: 'diplomacy_messages', strict: true,
  schema: { type: 'object', properties: { messages: { type: 'array', maxItems: 6,
    items: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'], additionalProperties: false } } },
  required: ['messages'], additionalProperties: false } } as const;
const UNIT_ORDERS_FORMAT = { type: 'json_schema', name: 'diplomacy_unit_orders', strict: true,
  schema: { type: 'object', properties: { orders: { type: 'array', maxItems: 34,
    items: { type: 'object', properties: { unit: { type: 'string' }, choice: { type: 'integer' } }, required: ['unit', 'choice'], additionalProperties: false } },
    // A short private note the power writes to itself for later turns (it may be empty).
    note: { type: 'string' } },
  required: ['orders', 'note'], additionalProperties: false } } as const;
/**
 * The pinned requests of a model-only full game: its orders (one entry per unit), its retreats and
 * builds (a list of numbers), its opening messages, its replies. Development only.
 */
export type FullGameRequestKind = 'ORDERS' | 'UNIT_ORDERS' | 'ASK' | 'REPLY';
/**
 * A model-only full game may be played at a higher reasoning effort than the challenge's pinned low.
 * Reasoning counts toward the output ceiling, so each effort has its own; the reservation follows it.
 */
export type Effort = 'low' | 'medium' | 'high';
export const EFFORTS: readonly Effort[] = ['low','medium','high'];
export const LUNA_FULL_GAME_OUTPUT: Readonly<Record<Effort, number>> = Object.freeze({ low: LUNA_PRESET.maxOutputTokens, medium: 8_192, high: 16_384 });
export const FULL_GAME_REQUEST_KINDS: readonly FullGameRequestKind[] = ['ORDERS','UNIT_ORDERS','ASK','REPLY'];
export function buildLunaFullGameRequest(input: { context: string }, kind: FullGameRequestKind, effort: Effort = 'low') {
  const at = { effort, maxOutputTokens: LUNA_FULL_GAME_OUTPUT[effort] };
  if (kind === 'UNIT_ORDERS') return build(input,FULL_GAME_UNIT_INSTRUCTIONS,UNIT_ORDERS_FORMAT,at);
  return kind === 'ORDERS' ? build(input,FULL_GAME_INSTRUCTIONS,ORDERS_FORMAT,at) : build(input,kind === 'ASK' ? ASK_INSTRUCTIONS : REPLY_INSTRUCTIONS,MESSAGES_FORMAT,at);
}
/** Every serialized request this preset may send for a context. A transport refuses anything else. */
export const lunaRequestBodies = (input: { context: string }): string[] =>
  [buildLunaRequest(input).body, buildLunaChatRequest(input).body, ...EFFORTS.flatMap(effort => FULL_GAME_REQUEST_KINDS.map(kind => buildLunaFullGameRequest(input,kind,effort).body))];
function build(input: { context: string }, instructions: string, format: typeof ORDERS_FORMAT | typeof REPLY_FORMAT | typeof MESSAGES_FORMAT | typeof UNIT_ORDERS_FORMAT,
    at: { effort: Effort; maxOutputTokens: number } = { effort: LUNA_PRESET.reasoningEffort, maxOutputTokens: LUNA_PRESET.maxOutputTokens }) {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'context')
    || typeof input.context !== 'string' || !input.context.trim()
    || Buffer.byteLength(input.context, 'utf8') > LUNA_PRESET.maxContextBytes) {
    throw new Error('Invalid or oversized Luna context.');
  }
  const body = JSON.stringify({
    model: LUNA_PRESET.model, service_tier: LUNA_PRESET.serviceTier,
    reasoning: { effort: at.effort }, max_output_tokens: at.maxOutputTokens,
    store: false, background: false, stream: false, truncation: 'disabled',
    tools: [], tool_choice: 'none', instructions,
    input: [{ role: 'user', content: [{ type: 'input_text', text: input.context }] }],
    text: { format },
  });
  // Serialized bytes are immutable, so later mutation cannot invalidate a reserved hash.
  return Object.freeze({ body, requestHash: createHash('sha256').update(body).digest('hex'),
    presetId: LUNA_PRESET.id, pricingVersion: LUNA_PRESET.pricingVersion });
}

/** Requires a verified input count/bound for this exact serialized request, NOT chars/4. */
export function lunaReservationNanousd(inputTokens: number, outputTokens: number = LUNA_PRESET.maxOutputTokens): number {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens > LUNA_PRESET.maxInputTokens) {
    throw new Error('Luna input token bound is unavailable or exceeds the preset.');
  }
  // Never assume a cache hit; a cache write is more expensive than ordinary input.
  if (!Object.values(LUNA_FULL_GAME_OUTPUT).includes(outputTokens)) throw new Error('Luna output ceiling is not one the preset allows.');
  return inputTokens * LUNA_PRESET.cacheWriteNanousd + outputTokens * LUNA_PRESET.outputNanousd;
}
