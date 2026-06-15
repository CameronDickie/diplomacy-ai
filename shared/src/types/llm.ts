import type { Phase, Power, Season } from './game.js';
import type { PublicBoardSnapshot } from './history.js';

export type LlmProviderId = 'STUB' | 'OPENAI' | 'ANTHROPIC' | 'OPENROUTER' | 'OLLAMA';

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
  provider: LlmProviderId;
  model: string;
  promptVersion: string;
  startedAt: string;
  latencyMs: number;
  retryCount: number;
  fallbackReason: string | null;
  validationErrors: string[];
  inputTokens: number | null;
  outputTokens: number | null;
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
