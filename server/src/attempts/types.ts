import type { Power, ChallengeAction } from '@diplomacy/shared';
import type { BoardFixture } from '../fixtures/BoardFixture.js';
import type { ChallengeDefinition } from '../challenge/TunisPilot.js';

/** Only choices from the current authoritative phase; no provider configuration. */
export type PhaseAction = ChallengeAction;
export type PhaseDecisions = Partial<Record<Power, PhaseAction>>;
export interface PhaseFence { operationId: string; attemptId: string; phaseId: string; revision: number }
export interface PhaseJob extends PhaseFence {
  status: 'DECIDING' | 'RESOLVING' | 'RECOVERING' | 'COMMITTED' | 'CANCELLED';
  playerId: string;
  requestId: string;
  board: BoardFixture;
  definition: ChallengeDefinition;
  humanAction: PhaseAction;
  decisions: PhaseDecisions | null;
  reportOffset: number;
  createdAt: number;
}
