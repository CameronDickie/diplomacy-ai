import type { Power, Season, Phase, GameStatus } from './game.js';
import type { TerritoryId, TerritoryState } from './territory.js';
import type { Unit } from './unit.js';
import type { AdjudicationResult } from './order.js';

export interface Player {
  socketId: string;
  name: string;
  power: Power;
  connected: boolean;
}

export interface GameState {
  gameId: string;
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
