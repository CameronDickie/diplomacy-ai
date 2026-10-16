import type { ProviderUsage } from './accounting.js';
import { HAIKU_PRESET } from './HaikuPreset.js';
import type { ProviderResponse } from './RecordedCall.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_000_000;
/** The API reports an absent cache figure as null. */
const optional = (value: unknown): number | null => value == null ? 0 : count(value) ? value : null;

/**
 * Missing or inconsistent usage is unknown, never zero. Unlike the Responses envelope, `input_tokens`
 * here excludes cached tokens, so the stored input total is the sum of the three input figures.
 */
function priceUsage(value: unknown): ProviderUsage | null {
  const u = object(value);
  if (!u || !count(u.input_tokens) || !count(u.output_tokens)) return null;
  const read = optional(u.cache_read_input_tokens), written = optional(u.cache_creation_input_tokens);
  if (read === null || written === null) return null;
  // Server tools were not requested: any use may carry charges that token usage does not show.
  const tools = object(u.server_tool_use);
  if (u.server_tool_use != null && (!tools || Object.values(tools).some(n => n !== 0))) return null;
  const split = object(u.cache_creation), details = object(u.output_tokens_details);
  let fiveMinute = 0, oneHour = written;
  if (split) {
    if (!count(split.ephemeral_5m_input_tokens) || !count(split.ephemeral_1h_input_tokens)
      || split.ephemeral_5m_input_tokens + split.ephemeral_1h_input_tokens !== written) return null;
    fiveMinute = split.ephemeral_5m_input_tokens; oneHour = split.ephemeral_1h_input_tokens;
  }
  // Without a breakdown, a cache write is priced at the dearer one-hour rate.
  const thinking = details?.thinking_tokens == null ? 0 : details.thinking_tokens;
  if (!count(thinking) || thinking > u.output_tokens) return null;
  const inputTokens = u.input_tokens + read + written;
  // Requests should never reach the long-prompt rate card, but preserve actual known billing
  // if the provider violates our input bound. The caller must halt on the ERROR status.
  const multiplier = inputTokens > HAIKU_PRESET.longPromptTokens ? HAIKU_PRESET.longPromptMultiplier : 1;
  const costNanousd = (u.input_tokens * HAIKU_PRESET.inputNanousd + read * HAIKU_PRESET.cachedInputNanousd
    + fiveMinute * HAIKU_PRESET.cacheWrite5mNanousd + oneHour * HAIKU_PRESET.cacheWrite1hNanousd
    + u.output_tokens * HAIKU_PRESET.outputNanousd) * multiplier;
  return { inputTokens, cachedInputTokens: read, cacheWriteTokens: written, outputTokens: u.output_tokens, reasoningTokens: thinking, costNanousd };
}

/**
 * Normalize a Messages API answer; never parse decision JSON here. recordedCall must commit these
 * billing fields before JSON parsing or legal validation. No raw errors, refusal detail, thinking
 * or provider metadata escape this projection. Only standard-tier `claude-haiku-5-5` is priced.
 */
/** `maxOutputTokens`: the ceiling the request was sent with (a full game at a higher reasoning effort allows more). */
export function normalizeHaikuResponse(value: unknown, httpStatus = 200, maxOutputTokens: number = HAIKU_PRESET.maxOutputTokens): ProviderResponse {
  const r = object(value);
  const responseId = typeof r?.id === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(r.id) ? r.id : null;
  const pricedContract = r?.type === 'message' && r?.model === HAIKU_PRESET.model && object(r?.usage)?.service_tier === HAIKU_PRESET.serviceTier;
  let usage = pricedContract ? priceUsage(r?.usage) : null;
  const result = (status: ProviderResponse['status'], outputText: string | null = null): ProviderResponse => ({ responseId, usage, status, outputText });
  if (!r || !pricedContract || !responseId) return result('ERROR');
  // No tools were offered: any block other than thinking or text may imply charges absent from usage.
  const blocks = Array.isArray(r.content) ? r.content.map(object) : [];
  if (blocks.some(block => !['thinking', 'redacted_thinking', 'text'].includes(String(block?.type)))) {
    usage = null; return result('ERROR');
  }
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300 || !usage
    || usage.inputTokens > HAIKU_PRESET.maxInputTokens || usage.outputTokens > maxOutputTokens) return result('ERROR');
  // A safety decline is a normal, billed answer. It is checked before the content is read.
  if (r.stop_reason === 'refusal') return result('REFUSED');
  // Thinking spent the whole cap before the answer was finished.
  if (r.stop_reason === 'max_tokens') return result('INCOMPLETE');
  if (r.stop_reason !== 'end_turn' || r.role !== 'assistant' || !Array.isArray(r.content)) return result('ERROR');
  // The answer is read by type, never by position: thinking blocks come first.
  const text = blocks.filter(block => block?.type === 'text');
  if (text.length !== 1 || typeof text[0]?.text !== 'string' || Buffer.byteLength(text[0].text) > HAIKU_PRESET.maxResponseBytes) return result('ERROR');
  return result('COMPLETED', text[0].text);
}
