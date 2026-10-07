import type { PublicPhaseReport } from './history.js';
import type { Phase, Power, Season } from './game.js';

/** A game played entirely by the free practice bot in the background. It has no player and no private state. */
export interface ExhibitionSummary {
  id: string; title: string;
  state: 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STALLED' | 'CANCELLED' | 'FAILED';
  /** Why it ended: GAME_OVER, PHASE_LIMIT, NO_PROGRESS, REPEATED_POSITION, CANCELLED_BY_OPERATOR or RULES_ENGINE_ERROR. */
  reason: string | null;
  phases: number; maxPhases: number; year: number; season: Season; phase: Phase; createdAt: number; updatedAt: number;
  centers: Record<Power, number>;
}
export interface ExhibitionReplay { kind: 'EXHIBITION'; exhibition: ExhibitionSummary; reports: PublicPhaseReport[] }
