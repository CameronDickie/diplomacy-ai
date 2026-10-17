import { openAiRequests, type OpenAiPreset } from './LunaPreset.js';
import { openAiNormalizer } from './LunaResponse.js';

/**
 * OpenAI's GPT Sol 6.1 for model-only full games (development only), the stronger counterpart to
 * GPT-6 Luna. Same request shape, limits and schemas as Luna; only the model and prices differ.
 * Prices from OpenAI's price list as given by the owner on 2026-10-17, in integer USD nanodollars per
 * token: input $2.00, cached input $0.10, cache writes $2.50, output $10.00 per million.
 */
export const SOL_PRESET: OpenAiPreset = Object.freeze({
  id: 'sol-full-game-v1', model: 'gpt-6.1-sol', pricingVersion: 'sol-standard-2026-10-17',
  endpoint: 'https://api.openai.com/v1/responses', serviceTier: 'default',
  reasoningEffort: 'low', maxInputTokens: 32_768, maxOutputTokens: 2_048,
  maxContextBytes: 24_000, maxRequestBytes: 32_768, maxResponseBytes: 256 * 1024,
  countEndpoint: 'https://api.openai.com/v1/responses/input_tokens', countTimeoutMs: 5_000,
  maxCountResponseBytes: 4_096, timeoutMs: 20_000, retries: 0,
  maxConcurrentDecisions: 6,
  inputNanousd: 2_000, cachedInputNanousd: 100, cacheWriteNanousd: 2_500, outputNanousd: 10_000,
});
export const SOL_REQUESTS = openAiRequests(SOL_PRESET,Object.freeze({ low: SOL_PRESET.maxOutputTokens, medium: 8_192, high: 16_384 }),'Sol');
// Requests stay far below the long-context threshold. If a provider ever bills past it, output is priced
// at one and a half times the normal rate, as for Luna; this rate was not given and is an assumption.
export const normalizeSolResponse = openAiNormalizer(SOL_PRESET,15_000);
