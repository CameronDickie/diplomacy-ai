import { createHash } from 'node:crypto';
import { ASK_INSTRUCTIONS, CHAT_INSTRUCTIONS, FULL_GAME_INSTRUCTIONS, FULL_GAME_UNIT_INSTRUCTIONS, OPPONENT_INSTRUCTIONS, REPLY_INSTRUCTIONS } from './OpponentInstructions.js';
import { EFFORTS, FULL_GAME_REQUEST_KINDS, type Effort, type FullGameRequestKind } from './LunaPreset.js';

/**
 * One pinned Anthropic model: its settings, limits and integer USD nanodollar prices per token. Version
 * the whole contract (id and pricing version) whenever settings, schema or prices change.
 */
export interface AnthropicPreset {
  readonly id: string; readonly provider: 'ANTHROPIC'; readonly model: string; readonly pricingVersion: string; readonly serviceTier: string; readonly effort: 'low';
  readonly maxInputTokens: number; readonly maxOutputTokens: number; readonly maxContextBytes: number; readonly maxRequestBytes: number; readonly maxResponseBytes: number;
  readonly countTimeoutMs: number; readonly timeoutMs: number; readonly retries: 0; readonly maxConcurrentDecisions: number;
  readonly inputNanousd: number; readonly cachedInputNanousd: number; readonly cacheWrite5mNanousd: number; readonly cacheWrite1hNanousd: number; readonly outputNanousd: number;
  readonly longPromptTokens: number; readonly longPromptMultiplier: number;
}
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


const ORDERS_SCHEMA = { type: 'object', properties: { choices: { type: 'array', items: { type: 'integer' } } },
  required: ['choices'], additionalProperties: false } as const;
const REPLY_SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false } as const;
const MESSAGES_SCHEMA = { type: 'object', properties: { messages: { type: 'array',
  items: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'], additionalProperties: false } } },
  required: ['messages'], additionalProperties: false } as const;
const UNIT_ORDERS_SCHEMA = { type: 'object', properties: { orders: { type: 'array',
  items: { type: 'object', properties: { unit: { type: 'string' }, choice: { type: 'integer' } }, required: ['unit', 'choice'], additionalProperties: false } },
    note: { type: 'string' } },
  required: ['orders', 'note'], additionalProperties: false } as const;

/**
 * Every request one pinned Anthropic model may send, its worst-case price, and the output ceiling of a
 * full game at each reasoning effort. Only server-built game context enters the request; no model,
 * tools, sampling or fallback overrides. No `cache_control` is sent, so nothing is written to a prompt
 * cache, and no `fallbacks`: another model's rates must never apply to a reserved call. The schema
 * carries no numeric or length limits (the API rejects them); indices are bounded when parsed.
 * `name` appears in error messages only.
 */
export function anthropicRequests(preset: AnthropicPreset, fullGameOutput: Readonly<Record<Effort, number>>, name: string) {
  function build(input: { context: string }, system: string, schema: typeof ORDERS_SCHEMA | typeof REPLY_SCHEMA | typeof MESSAGES_SCHEMA | typeof UNIT_ORDERS_SCHEMA,
      at: { effort: Effort; maxOutputTokens: number } = { effort: preset.effort, maxOutputTokens: preset.maxOutputTokens }) {
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'context')
      || typeof input.context !== 'string' || !input.context.trim()
      || Buffer.byteLength(input.context, 'utf8') > preset.maxContextBytes) {
      throw new Error(`Invalid or oversized ${name} context.`);
    }
    const body = JSON.stringify({
      model: preset.model, max_tokens: at.maxOutputTokens, stream: false,
      thinking: { type: 'adaptive' },
      output_config: { effort: at.effort, format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: input.context }],
    });
    // Serialized bytes are immutable, so later mutation cannot invalidate a reserved hash.
    return Object.freeze({ body, requestHash: createHash('sha256').update(body).digest('hex'),
      presetId: preset.id, pricingVersion: preset.pricingVersion });
  }
  const buildRequest = (input: { context: string }) => build(input,OPPONENT_INSTRUCTIONS,ORDERS_SCHEMA);
  /** The same pinned settings, asking for one short reply to the player instead of a set of choices. */
  const buildChatRequest = (input: { context: string }) => build(input,CHAT_INSTRUCTIONS,REPLY_SCHEMA);
  function buildFullGameRequest(input: { context: string }, kind: FullGameRequestKind, effort: Effort = 'low') {
    const at = { effort, maxOutputTokens: fullGameOutput[effort] };
    if (kind === 'UNIT_ORDERS') return build(input,FULL_GAME_UNIT_INSTRUCTIONS,UNIT_ORDERS_SCHEMA,at);
    return kind === 'ORDERS' ? build(input,FULL_GAME_INSTRUCTIONS,ORDERS_SCHEMA,at) : build(input,kind === 'ASK' ? ASK_INSTRUCTIONS : REPLY_INSTRUCTIONS,MESSAGES_SCHEMA,at);
  }
  /** Every serialized request this preset may send for a context. A transport refuses anything else. */
  const requestBodies = (input: { context: string }): string[] =>
    [buildRequest(input).body, buildChatRequest(input).body, ...EFFORTS.flatMap(effort => FULL_GAME_REQUEST_KINDS.map(kind => buildFullGameRequest(input,kind,effort).body))];
  /** Requires a verified input count/bound for this exact serialized request, NOT chars/4. */
  function reservationNanousd(inputTokens: number, outputTokens: number = preset.maxOutputTokens): number {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens > preset.maxInputTokens) {
      throw new Error(`${name} input token bound is unavailable or exceeds the preset.`);
    }
    // Never assume a cache hit; the dearest input rate is a one-hour cache write.
    if (!Object.values(fullGameOutput).includes(outputTokens)) throw new Error(`${name} output ceiling is not one the preset allows.`);
    return inputTokens * preset.cacheWrite1hNanousd + outputTokens * preset.outputNanousd;
  }
  /** A provider-shaped answer for the offline stand-in. */
  function mockEnvelope({ serial, text, inputTokens, outputTokens }: { serial: number; text: string; inputTokens: number; outputTokens: number }): unknown {
    return { id: `msg_mock_${serial}_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: preset.model,
      // A real answer begins with a thinking block whose text is omitted.
      content: [{ type: 'thinking', thinking: '', signature: 'mock' }, { type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 16 },
        server_tool_use: null, service_tier: preset.serviceTier } };
  }
  return Object.freeze({ preset, fullGameOutput, buildRequest, buildChatRequest, buildFullGameRequest, requestBodies, reservationNanousd, mockEnvelope });
}
export type AnthropicRequests = ReturnType<typeof anthropicRequests>;

export const HAIKU_REQUESTS = anthropicRequests(HAIKU_PRESET,Object.freeze({ low: HAIKU_PRESET.maxOutputTokens, medium: 8_192, high: 16_384 }),'Haiku');
/** A full game's output ceiling per reasoning effort; thinking counts toward it. */
export const HAIKU_FULL_GAME_OUTPUT = HAIKU_REQUESTS.fullGameOutput;
export const buildHaikuRequest = HAIKU_REQUESTS.buildRequest;
export const buildHaikuChatRequest = HAIKU_REQUESTS.buildChatRequest;
export const buildHaikuFullGameRequest = HAIKU_REQUESTS.buildFullGameRequest;
export const haikuRequestBodies = HAIKU_REQUESTS.requestBodies;
export const haikuReservationNanousd = HAIKU_REQUESTS.reservationNanousd;
export const mockHaikuEnvelope = HAIKU_REQUESTS.mockEnvelope;
export const haikuContextOf = (body: string): string => String(JSON.parse(body).messages[0].content);
