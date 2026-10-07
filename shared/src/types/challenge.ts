import type { Power, Phase, Season } from './game.js';
import type { PublicBoardSnapshot, PublicPhaseReport } from './history.js';
import type { Order } from './order.js';
import type { RetreatDestination, SubmitBuildsPayload, SubmissionState } from './socket.js';

export type ChallengeAction =
  | { phase: 'ORDERS'; orderIds: string[] }
  | { phase: 'RETREATS'; retreats: Record<string, RetreatDestination | null> }
  | { phase: 'BUILDS'; builds: SubmitBuildsPayload['builds']; disbands: string[] };
export interface ChallengeCard {
  id: string; version: number; title: string; objectiveText: string; humanPower: Power;
  deadlineYear: number; earlyAchievementYear: number;
  label: 'DEVELOPMENT_PILOT'; mode: 'PRACTICE'; opponentLabel: string;
  board: PublicBoardSnapshot & {year:number;season:Season;phase:Phase};
}
export interface ChallengeAttemptView {
  id: string; revision: number; phaseId: string; challenge: ChallengeCard;
  lifecycle: 'ACTIVE' | 'COMPLETED' | 'ABANDONED' | 'EXPIRED' | 'STOPPED';
  execution: 'ACCEPTING' | 'DECIDING' | 'RESOLVING' | 'RECOVERING' | 'IDLE';
  mode: 'PRACTICE';
  board: ChallengeCard['board'];
  score: {outcome:'INCOMPLETE'|'SUCCESS'|'FAILURE'|'ABANDONED';reason:string;completedYear:number|null;achievementIds:readonly string[]}|null;
  receipt: SubmissionState | null; acceptedAction: ChallengeAction | null;
  lastActivityAt:number; idleWarnAt:number; expiresAt:number;
}
export interface ChallengeLegalCatalog { attemptId:string; phaseId:string; revision:number; options:Array<{id:string;unitTerritory:string;order:Order;description:string}> }
export interface ChallengeReplay { challenge:ChallengeCard; reports:PublicPhaseReport[] }
