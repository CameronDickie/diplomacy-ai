import { createHash } from 'node:crypto';
import { ASK_INSTRUCTIONS, CHAT_INSTRUCTIONS, FULL_GAME_INSTRUCTIONS, FULL_GAME_UNIT_INSTRUCTIONS, OPPONENT_INSTRUCTIONS, REPLY_INSTRUCTIONS } from './OpponentInstructions.js';

/**
 * One pinned OpenAI model: its settings, limits and integer USD nanodollar prices per token. Version
 * the whole contract (id and pricing version) whenever settings, schema or prices change.
 */
export interface OpenAiPreset {
  readonly id: string; readonly model: string; readonly pricingVersion: string; readonly endpoint: string; readonly serviceTier: string;
  readonly reasoningEffort: 'low'; readonly maxInputTokens: number; readonly maxOutputTokens: number;
  readonly maxContextBytes: number; readonly maxRequestBytes: number; readonly maxResponseBytes: number;
  readonly countEndpoint: string; readonly countTimeoutMs: number; readonly maxCountResponseBytes: number; readonly timeoutMs: number; readonly retries: 0;
  readonly maxConcurrentDecisions: number;
  readonly inputNanousd: number; readonly cachedInputNanousd: number; readonly cacheWriteNanousd: number; readonly outputNanousd: number;
}
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
export const FULL_GAME_REQUEST_KINDS: readonly FullGameRequestKind[] = ['ORDERS','UNIT_ORDERS','ASK','REPLY'];

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
 * Every request one pinned OpenAI model may send, its worst-case price, and the output ceiling of a
 * full game at each reasoning effort. Only server-built game context enters a request; no model, role,
 * tier or tools overrides. `name` appears in error messages only.
 */
export function openAiRequests(preset: OpenAiPreset, fullGameOutput: Readonly<Record<Effort, number>>, name: string) {
  function build(input: { context: string }, instructions: string, format: typeof ORDERS_FORMAT | typeof REPLY_FORMAT | typeof MESSAGES_FORMAT | typeof UNIT_ORDERS_FORMAT,
      at: { effort: Effort; maxOutputTokens: number } = { effort: preset.reasoningEffort, maxOutputTokens: preset.maxOutputTokens }) {
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'context')
      || typeof input.context !== 'string' || !input.context.trim()
      || Buffer.byteLength(input.context, 'utf8') > preset.maxContextBytes) {
      throw new Error(`Invalid or oversized ${name} context.`);
    }
    const body = JSON.stringify({
      model: preset.model, service_tier: preset.serviceTier,
      reasoning: { effort: at.effort }, max_output_tokens: at.maxOutputTokens,
      store: false, background: false, stream: false, truncation: 'disabled',
      tools: [], tool_choice: 'none', instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: input.context }] }],
      text: { format },
    });
    // Serialized bytes are immutable, so later mutation cannot invalidate a reserved hash.
    return Object.freeze({ body, requestHash: createHash('sha256').update(body).digest('hex'),
      presetId: preset.id, pricingVersion: preset.pricingVersion });
  }
  const buildRequest = (input: { context: string }) => build(input,OPPONENT_INSTRUCTIONS,ORDERS_FORMAT);
  /** The same pinned settings, asking for one short reply to the player instead of a set of choices. */
  const buildChatRequest = (input: { context: string }) => build(input,CHAT_INSTRUCTIONS,REPLY_FORMAT);
  function buildFullGameRequest(input: { context: string }, kind: FullGameRequestKind, effort: Effort = 'low') {
    const at = { effort, maxOutputTokens: fullGameOutput[effort] };
    if (kind === 'UNIT_ORDERS') return build(input,FULL_GAME_UNIT_INSTRUCTIONS,UNIT_ORDERS_FORMAT,at);
    return kind === 'ORDERS' ? build(input,FULL_GAME_INSTRUCTIONS,ORDERS_FORMAT,at) : build(input,kind === 'ASK' ? ASK_INSTRUCTIONS : REPLY_INSTRUCTIONS,MESSAGES_FORMAT,at);
  }
  /** Every serialized request this preset may send for a context. A transport refuses anything else. */
  const requestBodies = (input: { context: string }): string[] =>
    [buildRequest(input).body, buildChatRequest(input).body, ...EFFORTS.flatMap(effort => FULL_GAME_REQUEST_KINDS.map(kind => buildFullGameRequest(input,kind,effort).body))];
  /** Requires a verified input count/bound for this exact serialized request, NOT chars/4. */
  function reservationNanousd(inputTokens: number, outputTokens: number = preset.maxOutputTokens): number {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens > preset.maxInputTokens) {
      throw new Error(`${name} input token bound is unavailable or exceeds the preset.`);
    }
    // Never assume a cache hit; a cache write is more expensive than ordinary input.
    if (!Object.values(fullGameOutput).includes(outputTokens)) throw new Error(`${name} output ceiling is not one the preset allows.`);
    return inputTokens * preset.cacheWriteNanousd + outputTokens * preset.outputNanousd;
  }
  return Object.freeze({ preset, fullGameOutput, buildRequest, buildChatRequest, buildFullGameRequest, requestBodies, reservationNanousd });
}
export type OpenAiRequests = ReturnType<typeof openAiRequests>;

export const LUNA_REQUESTS = openAiRequests(LUNA_PRESET,Object.freeze({ low: LUNA_PRESET.maxOutputTokens, medium: 8_192, high: 16_384 }),'Luna');
export const LUNA_FULL_GAME_OUTPUT = LUNA_REQUESTS.fullGameOutput;
/** Only server-built game context enters the request; no model, role, tier or tools overrides. */
export const buildLunaRequest = LUNA_REQUESTS.buildRequest;
export const buildLunaChatRequest = LUNA_REQUESTS.buildChatRequest;
export const buildLunaFullGameRequest = LUNA_REQUESTS.buildFullGameRequest;
export const lunaRequestBodies = LUNA_REQUESTS.requestBodies;
export const lunaReservationNanousd = LUNA_REQUESTS.reservationNanousd;
