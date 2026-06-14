import type { Phase, Power, Season } from './game.js';

export type LlmProviderId = 'STUB' | 'OPENAI' | 'ANTHROPIC' | 'OPENROUTER' | 'OLLAMA';

export type LlmRunStatus = 'IDLE' | 'THINKING' | 'RETRYING' | 'FALLBACK';

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
}
