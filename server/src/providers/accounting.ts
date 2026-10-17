import type { Power } from '@diplomacy/shared';
import type { PhaseFence } from '../attempts/types.js';

/** Private accounting metadata only. Never store prompts, credentials or output here. */
export interface ProviderCallIntent {
  id: string;
  fence: PhaseFence;
  power: Power;
  provider: 'OPENAI' | 'ANTHROPIC';
  /** GPT Sol 6.1 and Claude Sonnet 5.5 are used only in model-only full games (development). */
  model: 'gpt-6-luna' | 'claude-haiku-5-5' | 'gpt-6.1-sol' | 'claude-sonnet-5-5';
  /**
   * CHAT is a reply to one player message; its fence's operation id is that message's id.
   * ASK and REPLY are one power's messages to other powers before an orders phase of a model-only
   * full game; they are fenced to that phase like its decisions.
   */
  role: 'ORDERS' | 'RETREATS' | 'BUILDS' | 'CHAT' | 'ASK' | 'REPLY';
  pricingVersion: string;
  requestHash: string;
  maxCostNanousd: number;
}
export interface ProviderUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costNanousd: number;
}
export const providerOutcomes = ['VALID','INVALID_JSON','INVALID_ACTION','REFUSED','INCOMPLETE','PROVIDER_ERROR','TRANSPORT_ERROR','TIMEOUT','CANCELLED'] as const;
export type ProviderOutcome = typeof providerOutcomes[number];
export interface ProviderCallRecord extends ProviderCallIntent {
  state: 'PREPARED' | 'DISPATCHED' | 'RECEIVED' | 'FINISHED';
  createdAt: number;
  dispatchedAt: number | null;
  receivedAt: number | null;
  finishedAt: number | null;
  responseId: string | null;
  usage: ProviderUsage | null;
  outcome: ProviderOutcome | null;
}
export interface ProviderTotals {
  calls: number;
  knownCalls: number;
  unresolvedCalls: number;
  knownCostNanousd: number;
  unresolvedLiabilityNanousd: number;
  inputTokens: number;
  outputTokens: number;
}
