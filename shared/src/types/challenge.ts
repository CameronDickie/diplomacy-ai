import type { Power, Phase, Season } from './game.js';
import type { PublicBoardSnapshot, PublicPhaseReport } from './history.js';
import type { Order } from './order.js';
import type { RetreatDestination, SubmitBuildsPayload, SubmissionState } from './socket.js';

export type ChallengeAction =
  | { phase: 'ORDERS'; orderIds: string[] }
  | { phase: 'RETREATS'; retreats: Record<string, RetreatDestination | null> }
  | { phase: 'BUILDS'; builds: SubmitBuildsPayload['builds']; disbands: string[] };
export interface ChallengeCard {
  id: string; version: number; title: string; objectiveText: string; humanPower: Power; targetTerritory: string;
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
export interface ChallengeHistoryPage { attempts:ChallengeAttemptView[]; next:string|null }
export interface ChallengeLegalCatalog { attemptId:string; phaseId:string; revision:number; options:Array<{id:string;unitTerritory:string;order:Order;description:string}> }
/** Server-enforced limits, published so visitor copy never drifts from what admission actually applies. */
export interface ChallengeLimits { maxActiveAttempts:number; maxActivePerAccount:number; dailyStartLimit:number; idleWarnMinutes:number; idleExpireMinutes:number; resultRetentionDays:number }
/**
 * `sponsoredPlay`: NOT_OFFERED until the funded adapter is enabled, PAUSED while the operator or an
 * exhausted budget has stopped it. `capacity` reflects the global active-attempt limit right now.
 */
/** Which pinned scenario is featured for the current UTC day. A development rotation is not a public daily schedule. */
export interface ChallengeRotation { id:string; version:number; label:'DEVELOPMENT_ROTATION'; day:string; index:number; size:number; nextChangeAt:number }
export interface ChallengeCatalog { challenges:ChallengeCard[]; rotation:ChallengeRotation; limits:ChallengeLimits; sponsoredPlay:'NOT_OFFERED'|'PAUSED'|'OPEN'; capacity:'OPEN'|'FULL' }
/** `REFERENCE` is the packaged public run; a player's own phase history is never served under this type. */
export interface ChallengeReplay { kind:'REFERENCE'; challenge:ChallengeCard; reports:PublicPhaseReport[] }
