import { createHash } from 'node:crypto';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { HAIKU_PRESET, buildHaikuChatRequest, buildHaikuRequest, haikuContextOf, haikuReservationNanousd, mockHaikuEnvelope } from './HaikuPreset.js';
import { normalizeHaikuResponse } from './HaikuResponse.js';
import { LUNA_PRESET, buildLunaChatRequest, buildLunaRequest, lunaReservationNanousd } from './LunaPreset.js';
import { normalizeLunaResponse } from './LunaResponse.js';
import type { ProviderResponse } from './RecordedCall.js';

/** The limits every sponsored opponent preset pins. Prices and wire details stay inside each preset. */
export interface OpponentPreset {
  id: string;
  provider: 'OPENAI' | 'ANTHROPIC';
  model: 'gpt-6-luna' | 'claude-haiku-5-5';
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
  key: 'luna' | 'haiku';
  preset: OpponentPreset;
  /** Hash of every pinned setting and price, recorded in evaluation manifests. */
  presetHash: string;
  buildRequest(input: { context: string }): OpponentRequest;
  /** The pinned request for one short reply to the player's message. Same model, limits and prices. */
  buildChatRequest(input: { context: string }): OpponentRequest;
  /** Worst-case cost of one call given a verified input-token bound. */
  reservationNanousd(inputTokens: number): number;
  /** Billing fields and status only; decision JSON is parsed later, after the bill is recorded. */
  normalizeResponse(body: unknown, httpStatus: number): ProviderResponse;
  /** The game context inside a serialized request, as the model would read it. */
  contextOf(body: string): string;
  /** A provider-shaped answer for the offline stand-in. */
  mockEnvelope(input: { serial: number; text: string; inputTokens: number; outputTokens: number }): unknown;
}

const hash = (preset: object) => createHash('sha256').update(canonicalJson(preset)).digest('hex');

export const LUNA_CONTRACT: OpponentContract = Object.freeze({
  key: 'luna' as const, preset: { ...LUNA_PRESET, provider: 'OPENAI' as const }, presetHash: hash(LUNA_PRESET),
  buildRequest: buildLunaRequest, buildChatRequest: buildLunaChatRequest, reservationNanousd: lunaReservationNanousd, normalizeResponse: normalizeLunaResponse,
  contextOf: (body: string) => String(JSON.parse(body).input[0].content[0].text),
  mockEnvelope: ({ serial, text, inputTokens, outputTokens }: { serial: number; text: string; inputTokens: number; outputTokens: number }) => ({
    id: `resp_mock_${serial}_${Date.now().toString(36)}`, model: LUNA_PRESET.model, service_tier: LUNA_PRESET.serviceTier, status: 'completed', error: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 16 } },
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] }),
});

export const HAIKU_CONTRACT: OpponentContract = Object.freeze({
  key: 'haiku' as const, preset: HAIKU_PRESET, presetHash: hash(HAIKU_PRESET),
  buildRequest: buildHaikuRequest, buildChatRequest: buildHaikuChatRequest, reservationNanousd: haikuReservationNanousd, normalizeResponse: normalizeHaikuResponse,
  contextOf: haikuContextOf, mockEnvelope: mockHaikuEnvelope,
});

export const OPPONENT_CONTRACTS: Readonly<Record<OpponentContract['key'], OpponentContract>> = Object.freeze({ luna: LUNA_CONTRACT, haiku: HAIKU_CONTRACT });

export function opponentContract(key: string): OpponentContract {
  if (!Object.hasOwn(OPPONENT_CONTRACTS,key)) throw new Error(`Unknown sponsored preset "${key}". Use ${Object.keys(OPPONENT_CONTRACTS).join(' or ')}.`);
  return OPPONENT_CONTRACTS[key as OpponentContract['key']];
}
