import type { Phase, Power, Season } from './game.js';
import type { PublicBoardSnapshot } from './history.js';

export type LlmProviderId =
  | 'STUB'
  | 'OPENAI'
  | 'GEMINI'
  | 'ANTHROPIC'
  | 'OPENROUTER'
  | 'OLLAMA';

export type LlmModelRole =
  | 'DIPLOMACY_INITIATIVE'
  | 'DIPLOMACY_REPLY'
  | 'ORDERS'
  | 'RETREATS'
  | 'BUILDS'
  | 'MEMORY';

export type LlmRunStatus = 'IDLE' | 'THINKING' | 'RETRYING' | 'FALLBACK';
export type LlmJournalStatus =
  | 'QUEUED'
  | 'THINKING'
  | 'RETRYING'
  | 'FALLBACK'
  | 'COMPLETE';

export interface DiplomaticAgreement {
  id: string;
  parties: Power[];
  summary: string;
  status: 'PROPOSED' | 'ACTIVE' | 'BROKEN' | 'EXPIRED';
  sourceMessageIds: string[];
  createdYear: number;
  createdSeason: Season;
  expiresYear: number | null;
  expiresSeason: Season | null;
}

export interface LlmRunArtifact {
  id: string;
  power: Power;
  year: number;
  season: Season;
  phase: Phase;
  purpose: 'DIPLOMACY' | 'ORDERS' | 'RETREATS' | 'BUILDS';
  modelRole: LlmModelRole;
  provider: LlmProviderId;
  model: string;
  promptVersion: string;
  boardContextVersion: string;
  legalOrderCount: number | null;
  selectedLegalOrderIds: string[];
  startedAt: string;
  latencyMs: number;
  retryCount: number;
  fallbackReason: string | null;
  validationErrors: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  contextMessageIds: string[];
  memoryRevisionBefore: number;
  strategicSummary: string | null;
  agreementsBefore: DiplomaticAgreement[];
  agreementsAfter: DiplomaticAgreement[];
  structuredDecision: unknown;
  boardSnapshot: PublicBoardSnapshot;
  statusHistory: Array<{
    status: LlmJournalStatus;
    at: string;
  }>;
}

export interface LlmRunSummary {
  id: string;
  power: Power;
  purpose: LlmRunArtifact['purpose'];
  provider: LlmProviderId;
  model: string;
  outcome: 'COMPLETE' | 'FALLBACK';
  latencyMs: number;
  retryCount: number;
  fallbackReason: string | null;
  validationErrors: string[];
}

export interface LlmFallbackCounters {
  totalRuns: number;
  successfulRuns: number;
  fallbackRuns: number;
  fallbackRate: number;
  totalRetries: number;
  byPurpose: Record<
    LlmRunArtifact['purpose'],
    { totalRuns: number; fallbackRuns: number }
  >;
}
