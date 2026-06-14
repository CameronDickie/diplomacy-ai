import type { Power, Season, Phase, GameStatus } from './game.js';
import type { TerritoryId, TerritoryState } from './territory.js';
import type { Unit } from './unit.js';
import type { AdjudicationResult } from './order.js';

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
  provider: 'STUB' | 'OPENAI' | 'ANTHROPIC' | 'OPENROUTER' | 'OLLAMA';
  model: string;
  persona: string | null;
}

export type Player = HumanPlayer | LlmPlayer;

export interface GameState {
  gameId: string;
  hostPlayerId: string;
  year: number;
  season: Season;
  phase: Phase;
  territories: Record<TerritoryId, TerritoryState>;
  units: Unit[];
  players: Player[];
  submittedPowers: Power[];
  lastAdjudicationResult: AdjudicationResult | null;
  status: GameStatus;
  winner: Power | null;
}
