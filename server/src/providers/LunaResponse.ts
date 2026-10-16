import type { ProviderUsage } from './accounting.js';
import type { ProviderResponse } from './RecordedCall.js';
import { LUNA_PRESET } from './LunaPreset.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_000_000;

/** Missing/partial usage is unknown, never zero or an optimistic cached-input estimate. */
function priceUsage(value: unknown): ProviderUsage | null {
  const u = object(value), input = object(u?.input_tokens_details), output = object(u?.output_tokens_details);
  if (!u || !input || !output || !count(u.input_tokens) || !count(u.output_tokens)
    || !count(u.total_tokens) || !count(input.cached_tokens) || !count(input.cache_write_tokens)
    || !count(output.reasoning_tokens) || u.total_tokens !== u.input_tokens + u.output_tokens
    || input.cached_tokens + input.cache_write_tokens > u.input_tokens || output.reasoning_tokens > u.output_tokens) return null;
  // Requests should never reach long-context pricing, but preserve actual known billing
  // if a provider violates our input bound. The caller must halt on the ERROR status.
  const inputMultiplier = u.input_tokens > 272_000 ? 2 : 1;
  const outputRate = u.input_tokens > 272_000 ? 750 : LUNA_PRESET.outputNanousd;
  const costNanousd = ((u.input_tokens - input.cached_tokens - input.cache_write_tokens) * LUNA_PRESET.inputNanousd
    + input.cached_tokens * LUNA_PRESET.cachedInputNanousd + input.cache_write_tokens * LUNA_PRESET.cacheWriteNanousd) * inputMultiplier
    + u.output_tokens * outputRate;
  return { inputTokens: u.input_tokens, cachedInputTokens: input.cached_tokens, cacheWriteTokens: input.cache_write_tokens,
    outputTokens: u.output_tokens, reasoningTokens: output.reasoning_tokens, costNanousd };
}

/**
 * Normalize the Responses envelope, never parse decision JSON here. recordedCall must
 * commit these billing fields before JSON parsing or legal validation. No raw errors,
 * refusal text, reasoning, annotations or provider metadata escape this projection.
 * Only the preset's global endpoint / Standard service is priced by this adapter.
 */
/** `maxOutputTokens`: the ceiling the request was sent with (a full game at a higher reasoning effort allows more). */
export function normalizeLunaResponse(value: unknown, httpStatus = 200, maxOutputTokens: number = LUNA_PRESET.maxOutputTokens): ProviderResponse {
  const r = object(value);
  const responseId = typeof r?.id === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(r.id) ? r.id : null;
  const pricedContract = r?.model === LUNA_PRESET.model && r?.service_tier === LUNA_PRESET.serviceTier;
  let usage = pricedContract ? priceUsage(r?.usage) : null;
  const result = (status: ProviderResponse['status'], outputText: string | null = null): ProviderResponse => ({ responseId, usage, status, outputText });
  if (!r || !pricedContract || !responseId) return result('ERROR');
  // Tool use was disabled: unexpected tool output may imply charges absent from token usage.
  const items = Array.isArray(r.output) ? r.output : [];
  if (items.some(item => !['message', 'reasoning'].includes(String(object(item)?.type)))) {
    usage = null; return result('ERROR');
  }
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300 || !usage
    || usage.inputTokens > LUNA_PRESET.maxInputTokens || usage.outputTokens > maxOutputTokens) return result('ERROR');
  if (r.status === 'incomplete') return result('INCOMPLETE');
  if (r.status !== 'completed' || r.error != null || !Array.isArray(r.output)) return result('ERROR');
  const messages = items.filter(item => object(item)?.type === 'message').map(object);
  if (messages.length !== 1 || messages[0]?.role !== 'assistant' || messages[0]?.status !== 'completed'
    || !Array.isArray(messages[0]?.content) || messages[0].content.length !== 1) return result('ERROR');
  const content = object(messages[0].content[0]);
  if (content?.type === 'refusal') return result('REFUSED');
  if (content?.type !== 'output_text' || typeof content.text !== 'string'
    || Buffer.byteLength(content.text) > LUNA_PRESET.maxResponseBytes) return result('ERROR');
  return result('COMPLETED', content.text);
}
