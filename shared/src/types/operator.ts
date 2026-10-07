import type { ChallengeCard } from './challenge.js';
import type { PublicPhaseReport } from './history.js';
import type { Phase, Season } from './game.js';

export interface OperatorSpend { calls:number; unresolvedCalls:number; knownCostNanousd:number; unresolvedLiabilityNanousd:number; inputTokens:number; outputTokens:number }
export interface OperatorAttemptRow {
  id:string; playerId:string; playerProvider:'github'|'google'; playerBanned:boolean; challengeId:string; challengeVersion:number; mode:'PRACTICE'|'BOT'|'SPONSORED';
  lifecycle:'ACTIVE'|'COMPLETED'|'ABANDONED'|'EXPIRED'|'STOPPED'; execution:'ACCEPTING'|'DECIDING'|'RESOLVING'|'RECOVERING'|'IDLE';
  year:number; season:Season; phase:Phase; createdAt:number; updatedAt:number; lastActivityAt:number;
}
export interface OperatorNotification {
  id:number; dedupeKey:string; kind:'ATTEMPT_STARTED'|'CREDIT_REQUEST'; payload:Record<string,string|number|null>;
  state:'PENDING'|'SENDING'|'SENT'|'FAILED'; attempts:number; nextAttemptAt:number; createdAt:number; sentAt:number|null; channel:'outbox'|'resend'|null; lastError:string|null;
}
/** The cumulative ledger in USD billionths. Settled never decreases; available = ceiling − settled − reserved − unknown liability. */
export interface OperatorFunding { grantedNanousd:number; ceilingNanousd:number; settledNanousd:number; reservedNanousd:number; unknownLiabilityNanousd:number; availableNanousd:number; attemptCapNanousd:number; grants:number }
export interface OperatorPaidState { stopped:boolean; episode:number; updatedAt:number|null }
export interface OperatorOverview {
  activeAttempts:number; maxActiveAttempts:number; attempts:OperatorAttemptRow[]; spend:OperatorSpend;
  funding:OperatorFunding;
  /** Worst-case cost held for calls still in flight (same figure as `funding.reservedNanousd`). */
  reservedNanousd:number;
  paid:OperatorPaidState; paidConfigured:boolean; notifyMode:'outbox'|'resend';
  outbox:{counts:Record<OperatorNotification['state'],number>;recent:OperatorNotification[]};
  audit:Array<{at:number;operatorId:string;action:string;target:string|null}>;
}
export interface OperatorAttemptDetail { attempt:OperatorAttemptRow; board:ChallengeCard['board']; score:{outcome:string;reason:string;completedYear:number|null;achievementIds:readonly string[]}|null; reports:PublicPhaseReport[]; spend:OperatorSpend; funding:{settledNanousd:number;heldNanousd:number} }
