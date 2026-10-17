import { anthropicRequests, type AnthropicPreset } from './HaikuPreset.js';
import { anthropicNormalizer } from './HaikuResponse.js';

/**
 * Anthropic's Claude Sonnet 5.5 for model-only full games (development only), the stronger
 * counterpart to Claude Haiku 5.5. Same request shape, limits and schemas as Haiku; only the model and
 * prices differ. Prices from Anthropic's price list as given by the owner on 2026-10-17, in integer USD
 * nanodollars per token: input $2, output $10, cache write $2.50, cache read $0.10 per million.
 * The one-hour cache write was not given; it is set at twice the input rate, Anthropic's usual
 * relation (Haiku's preset has the same). No request writes to a cache, so it only sizes the
 * worst-case reservation.
 */
export const SONNET_PRESET: AnthropicPreset = Object.freeze({
  id: 'sonnet-full-game-v1', provider: 'ANTHROPIC', model: 'claude-sonnet-5-5', pricingVersion: 'sonnet-5-5-standard-2026-10-17',
  serviceTier: 'standard', effort: 'low',
  maxInputTokens: 32_768, maxOutputTokens: 4_096,
  maxContextBytes: 24_000, maxRequestBytes: 32_768, maxResponseBytes: 256 * 1024,
  countTimeoutMs: 5_000, timeoutMs: 20_000, retries: 0,
  maxConcurrentDecisions: 6,
  inputNanousd: 2_000, cachedInputNanousd: 100, cacheWrite5mNanousd: 2_500, cacheWrite1hNanousd: 4_000, outputNanousd: 10_000,
  // The input bound keeps requests far below any long-prompt rate card; the same guard as Haiku's.
  longPromptTokens: 100_000, longPromptMultiplier: 5,
});
export const SONNET_REQUESTS = anthropicRequests(SONNET_PRESET,Object.freeze({ low: SONNET_PRESET.maxOutputTokens, medium: 8_192, high: 16_384 }),'Sonnet');
export const normalizeSonnetResponse = anthropicNormalizer(SONNET_PRESET);
