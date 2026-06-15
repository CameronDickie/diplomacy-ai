import type { Power, Season, Phase, GameStatus } from './game.js';
import type { TerritoryId, TerritoryState } from './territory.js';
import type { Unit } from './unit.js';
import type { AdjudicationResult } from './order.js';
import type { LlmProviderId } from './llm.js';

interface BasePlayer {
  id: string;
  name: string;
  power: Power;
}

export interface HumanPlayer extends BasePlayer {
  kind: 'HUMAN';
  connected: boolean;
}

export interface LlmPlayer extends BasePlayer {
  kind: 'LLM';
  provider: LlmProviderId;
  model: string;
  persona: string | null;
  realtimeModel: string;
  voice: string;
  voiceInstructions: string | null;
}

export type Player = HumanPlayer | LlmPlayer;

export interface GameSettings {
  llmNegotiationInitiators: number;
  llmNegotiationMaxMessages: number;
  llmNegotiationWarningAtMessages: number;
  llmNegotiationPlannerModel: string;
  publicLlmConversationPresence: boolean;
  voiceMaxSessionMinutes: number;
  voiceMaxTurns: number;
  voiceIdleTimeoutSeconds: number;
}

export interface GameState {
  gameId: string;
  hostPlayerId: string;
  year: number;
  season: Season;
  phase: Phase;
  territories: Record<TerritoryId, TerritoryState>;
  units: Unit[];
  players: Player[];
  settings: GameSettings;
  submittedPowers: Power[];
  lastAdjudicationResult: AdjudicationResult | null;
  status: GameStatus;
  winner: Power | null;
}
