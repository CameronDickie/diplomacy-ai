import { createHash } from 'node:crypto';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { HAIKU_REQUESTS, haikuContextOf, type AnthropicRequests } from './HaikuPreset.js';
import { normalizeHaikuResponse } from './HaikuResponse.js';
import { LUNA_REQUESTS, type Effort, type FullGameRequestKind, type OpenAiRequests } from './LunaPreset.js';
import { SOL_REQUESTS, normalizeSolResponse } from './SolPreset.js';
import { SONNET_REQUESTS, normalizeSonnetResponse } from './SonnetPreset.js';
import { normalizeLunaResponse } from './LunaResponse.js';
import type { ProviderResponse } from './RecordedCall.js';

/** The limits every sponsored opponent preset pins. Prices and wire details stay inside each preset. */
export interface OpponentPreset {
  id: string;
  provider: 'OPENAI' | 'ANTHROPIC';
  model: 'gpt-6-luna' | 'claude-haiku-5-5' | 'gpt-6.1-sol' | 'claude-sonnet-5-5';
  pricingVersion: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxContextBytes: number;
  maxRequestBytes: number;
  timeoutMs: number;
  maxConcurrentDecisions: number;
}
export interface OpponentRequest { body: string; requestHash: string; presetId: string; pricingVersion: string }

/**
 * Everything model-specific about a sponsored opponent, behind one seam. The decision provider,
 * funding ledger, recovery and legality checks are shared; a preset supplies only its exact request,
 * its worst-case price and how to read its provider's answer. An attempt is pinned to one preset.
 */
export interface OpponentContract {
  /** `sol` and `sonnet` are for model-only full games only; the server's configuration accepts only luna and haiku. */
  key: 'luna' | 'haiku' | 'sol' | 'sonnet';
  preset: OpponentPreset;
  /** Hash of every pinned setting and price, recorded in evaluation manifests. */
  presetHash: string;
  buildRequest(input: { context: string }): OpponentRequest;
  /** The pinned request for one short reply to the player's message. Same model, limits and prices. */
  buildChatRequest(input: { context: string }): OpponentRequest;
  /** A model-only full game's pinned requests: orders, opening messages to other powers, replies. Development only. */
  buildFullGameRequest(input: { context: string }, kind: FullGameRequestKind, effort?: Effort): OpponentRequest;
  /** A full game's output ceiling at each reasoning effort; the challenge always uses `low`. */
  fullGameOutputTokens: Readonly<Record<Effort, number>>;
  /** Worst-case cost of one call given a verified input-token bound, at the output ceiling it was sent with. */
  reservationNanousd(inputTokens: number, outputTokens?: number): number;
  /** Billing fields and status only; decision JSON is parsed later, after the bill is recorded. */
  normalizeResponse(body: unknown, httpStatus: number, maxOutputTokens?: number): ProviderResponse;
  /** The game context inside a serialized request, as the model would read it. */
  contextOf(body: string): string;
  /** A provider-shaped answer for the offline stand-in. */
  mockEnvelope(input: { serial: number; text: string; inputTokens: number; outputTokens: number }): unknown;
}

const hash = (preset: object) => createHash('sha256').update(canonicalJson(preset)).digest('hex');

/** One pinned OpenAI model behind the shared seam. */
function openAiContract(key: OpponentContract['key'], requests: OpenAiRequests, normalizeResponse: OpponentContract['normalizeResponse']): OpponentContract {
  const preset = requests.preset;
  return Object.freeze({
    key, preset: { ...preset, provider: 'OPENAI' as const, model: preset.model as OpponentPreset['model'] }, presetHash: hash(preset),
    buildRequest: requests.buildRequest, buildChatRequest: requests.buildChatRequest, buildFullGameRequest: requests.buildFullGameRequest,
    fullGameOutputTokens: requests.fullGameOutput, reservationNanousd: requests.reservationNanousd, normalizeResponse,
    contextOf: (body: string) => String(JSON.parse(body).input[0].content[0].text),
    mockEnvelope: ({ serial, text, inputTokens, outputTokens }: { serial: number; text: string; inputTokens: number; outputTokens: number }) => ({
      id: `resp_mock_${serial}_${Date.now().toString(36)}`, model: preset.model, service_tier: preset.serviceTier, status: 'completed', error: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 16 } },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] }),
  });
}
/** One pinned Anthropic model behind the shared seam. */
function anthropicContract(key: OpponentContract['key'], requests: AnthropicRequests, normalizeResponse: OpponentContract['normalizeResponse']): OpponentContract {
  const preset = requests.preset;
  return Object.freeze({
    key, preset: { ...preset, model: preset.model as OpponentPreset['model'] }, presetHash: hash(preset),
    buildRequest: requests.buildRequest, buildChatRequest: requests.buildChatRequest, buildFullGameRequest: requests.buildFullGameRequest,
    fullGameOutputTokens: requests.fullGameOutput, reservationNanousd: requests.reservationNanousd, normalizeResponse,
    contextOf: haikuContextOf, mockEnvelope: requests.mockEnvelope,
  });
}

export const LUNA_CONTRACT = openAiContract('luna',LUNA_REQUESTS,normalizeLunaResponse);
export const HAIKU_CONTRACT = anthropicContract('haiku',HAIKU_REQUESTS,normalizeHaikuResponse);
/** The stronger model of each provider, for model-only full games only (development). */
export const SOL_CONTRACT = openAiContract('sol',SOL_REQUESTS,normalizeSolResponse);
export const SONNET_CONTRACT = anthropicContract('sonnet',SONNET_REQUESTS,normalizeSonnetResponse);

export const OPPONENT_CONTRACTS: Readonly<Record<OpponentContract['key'], OpponentContract>> = Object.freeze({ luna: LUNA_CONTRACT, haiku: HAIKU_CONTRACT, sol: SOL_CONTRACT, sonnet: SONNET_CONTRACT });

export function opponentContract(key: string): OpponentContract {
  if (!Object.hasOwn(OPPONENT_CONTRACTS,key)) throw new Error(`Unknown sponsored preset "${key}". Use ${Object.keys(OPPONENT_CONTRACTS).join(' or ')}.`);
  return OPPONENT_CONTRACTS[key as OpponentContract['key']];
}
