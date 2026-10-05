import type { Power, RetreatDestination, SubmitBuildsPayload } from '@diplomacy/shared';
import type { BoardFixture } from '../fixtures/BoardFixture.js';
import type { ChallengeDefinition } from '../challenge/TunisPilot.js';

/** Only choices from the current authoritative phase; no provider configuration. */
export type PhaseAction =
  | { phase: 'ORDERS'; orderIds: string[] }
  | { phase: 'RETREATS'; retreats: Record<string, RetreatDestination | null> }
  | { phase: 'BUILDS'; builds: SubmitBuildsPayload['builds']; disbands: string[] };
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
