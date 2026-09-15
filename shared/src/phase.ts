import type { GameState } from './types/state.js';

/** Identifies the board phase a command was prepared against. */
export function gamePhaseId(state: Pick<GameState, 'gameId' | 'year' | 'season' | 'phase'>): string {
  return `${state.gameId}:${state.year}:${state.season}:${state.phase}`;
}
