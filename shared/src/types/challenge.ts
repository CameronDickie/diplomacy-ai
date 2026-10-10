import type { Power, Phase, Season } from './game.js';
import type { PublicBoardSnapshot, PublicPhaseReport } from './history.js';
import type { Order } from './order.js';
import type { RetreatDestination, SubmitBuildsPayload, SubmissionState } from './socket.js';

export type ChallengeAction =
  | { phase: 'ORDERS'; orderIds: string[] }
  | { phase: 'RETREATS'; retreats: Record<string, RetreatDestination | null> }
  | { phase: 'BUILDS'; builds: SubmitBuildsPayload['builds']; disbands: string[] };
/** PRACTICE opponents hold every turn. BOT is the free deterministic practice opponent. SPONSORED opponents are decided by the server-owned Luna preset. */
export type ChallengeMode = 'PRACTICE' | 'BOT' | 'SPONSORED';
export interface ChallengeCard {
  id: string; version: number; title: string; objectiveText: string; humanPower: Power; targetTerritory: string;
  deadlineYear: number; earlyAchievementYear: number;
  label: 'DEVELOPMENT_PILOT'; mode: ChallengeMode; opponentLabel: string;
  board: PublicBoardSnapshot & {year:number;season:Season;phase:Phase};
}
export interface ChallengeAttemptView {
  id: string; revision: number; phaseId: string; challenge: ChallengeCard;
  lifecycle: 'ACTIVE' | 'COMPLETED' | 'ABANDONED' | 'EXPIRED' | 'STOPPED';
  execution: 'ACCEPTING' | 'DECIDING' | 'RESOLVING' | 'RECOVERING' | 'IDLE';
  mode: ChallengeMode;
  /** Why a sponsored phase is waiting, when it is: paid play paused, this attempt's budget used, or a retry is possible. */
  notice: 'SPONSORED_PAUSED' | 'ATTEMPT_BUDGET' | 'SPONSORED_RETRY' | null;
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
export interface ChallengeCatalog { challenges:ChallengeCard[]; rotation:ChallengeRotation; limits:ChallengeLimits; sponsoredPlay:'NOT_OFFERED'|'PAUSED'|'OPEN'; sponsoredMock:boolean; /** Development playtest against real providers; never set by a production server. */ sponsoredLive?:boolean; capacity:'OPEN'|'FULL' }
/** `REFERENCE` is the packaged public run; a player's own phase history is never served under this type. */
export interface ChallengeReplay { kind:'REFERENCE'; challenge:ChallengeCard; reports:PublicPhaseReport[] }

/** One provider call in a development playtest. `decision` is the validated action it produced, if any. */
export interface PlaytestCall {
  power:Power; model:string; outcome:string|null; latencyMs:number|null;
  inputTokens:number|null; outputTokens:number|null; reasoningTokens:number|null;
  costNanousd:number|null; heldNanousd:number; decision:unknown|null;
}
export interface PlaytestPhase { phaseId:string; kind:'ORDERS'|'RETREATS'|'BUILDS'; calls:PlaytestCall[] }
export interface PlaytestModelTotals { calls:number; valid:number; costNanousd:number; heldNanousd:number; latencyMsTotal:number; timedCalls:number; outputTokens:number }
/** Development only: which model decided each power, what it chose, how long it took and what it cost. */
export interface PlaytestLog { attemptId:string; phases:PlaytestPhase[]; models:Record<string,PlaytestModelTotals> }
