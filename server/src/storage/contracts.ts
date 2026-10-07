import type { ProviderCallIntent, ProviderCallRecord, ProviderUsage, ProviderOutcome, ProviderTotals } from '../providers/accounting.js';
import type { PhaseAction, PhaseDecisions, PhaseFence, PhaseJob } from '../attempts/types.js';
import type { BoardFixture } from '../fixtures/BoardFixture.js';
import type { ChallengeDefinition, ChallengeScore } from '../challenge/TunisPilot.js';
import type { PublicPhaseReport, SubmissionState } from '@diplomacy/shared';

export interface StoredPlayer {
  id: string;
  provider: 'github' | 'google';
  subject: string;
  displayName: string;
  bannedAt: number | null;
}
export interface StoredSession { player: StoredPlayer; expiresAt: number }
export type AttemptLifecycle = 'ACTIVE' | 'COMPLETED' | 'ABANDONED' | 'EXPIRED' | 'STOPPED';
export type AttemptExecution = 'ACCEPTING' | 'DECIDING' | 'RESOLVING' | 'RECOVERING' | 'IDLE';
export interface StoredAttempt {
  mode: 'PRACTICE';
  id: string;
  playerId: string;
  challengeId: string;
  challengeVersion: number;
  revision: number;
  phaseId: string;
  lifecycle: AttemptLifecycle;
  execution: AttemptExecution;
  board: BoardFixture;
  score: ChallengeScore | null;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
}
export interface StoredChallenge { definition: ChallengeDefinition; board: BoardFixture; hash: string }
export interface StoredReceipt {
  attemptId: string;
  playerId: string;
  fingerprint: string;
  state: SubmissionState;
  createdAt: number;
}
export interface PaidState { stopped: boolean; episode: number; updatedAt: number | null }
export interface SpendTotals { calls:number; unresolvedCalls:number; knownCostNanousd:number; unresolvedLiabilityNanousd:number; inputTokens:number; outputTokens:number }
export type OutboxKind = 'ATTEMPT_STARTED' | 'CREDIT_REQUEST';
export interface OutboxMessage {
  id: number; dedupeKey: string; kind: OutboxKind; payload: Record<string,string|number|null>;
  state: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED'; attempts: number; nextAttemptAt: number; createdAt: number;
  sentAt: number | null; channel: 'outbox' | 'resend' | null; lastError: string | null;
}
/** What an operator may see of an attempt: pseudonymous owner, public position, timings. */
export interface OperatorAttemptRow {
  id: string; playerId: string; playerProvider: StoredPlayer['provider']; playerBanned: boolean;
  challengeId: string; challengeVersion: number; mode: 'PRACTICE'; lifecycle: AttemptLifecycle; execution: AttemptExecution;
  year: number; season: BoardFixture['season']; phase: BoardFixture['phase']; createdAt: number; updatedAt: number; lastActivityAt: number;
}
export type OperatorAction = 'ATTEMPT_STOP' | 'PLAYER_BAN' | 'PLAYER_UNBAN' | 'SPECTATE';
export interface StoreOperations {
  operatorOverview: { input: {}; output: { activeAttempts:number; attempts:OperatorAttemptRow[]; spend:SpendTotals; paid:PaidState; outbox:{counts:Record<OutboxMessage['state'],number>;recent:OutboxMessage[]}; audit:Array<{at:number;operatorId:string;action:string;target:string|null}> } };
  operatorAttempt: { input: { id:string }; output: { attempt:OperatorAttemptRow; board:BoardFixture; score:ChallengeScore|null; reports:PublicPhaseReport[]; spend:SpendTotals } | null };
  setPaidStopped: { input: { stopped:boolean; operatorId:string; now:number }; output: PaidState };
  recordOperatorAction: { input: { operatorId:string; action:OperatorAction; target:string; now:number }; output: null };
  paidState: { input: {}; output: PaidState };
  requestCredit: { input: { playerId:string; now:number }; output: { recorded:true; duplicate:boolean } };
  claimOutbox: { input: { now:number; limit:number; leaseMs:number }; output: OutboxMessage[] };
  settleOutbox: { input: { id:number; ok:true; channel:'outbox'|'resend'; now:number } | { id:number; ok:false; error:string; now:number }; output: OutboxMessage };
  prepareProviderCall: { input: { intent:ProviderCallIntent; now:number }; output: ProviderCallRecord };
  dispatchProviderCall: { input: { id:string; now:number }; output: ProviderCallRecord };
  receiveProviderCall: { input: { id:string; responseId:string|null; usage:ProviderUsage|null; now:number }; output: ProviderCallRecord };
  finishProviderCall: { input: { id:string; outcome:ProviderOutcome; now:number }; output: ProviderCallRecord };
  providerCall: { input: { id:string }; output: ProviderCallRecord|null };
  providerCallsForOperation: { input: { operationId:string }; output: ProviderCallRecord[] };
  providerCallTotals: { input: { operationId:string }; output: ProviderTotals };
  admitAttempt: { input: { id:string; playerId:string; requestId:string; challengeId:string; challengeVersion:number; now:number; maxActive:number; maxPerAccount:number; dailyLimit:number; replayOnly?:boolean }; output: StoredAttempt };
  ownedAttempts: { input: { playerId:string; before?:{createdAt:number;id:string}; limit?:number }; output: StoredAttempt[] };
  sweepRetention: { input: { now:number; resultBefore:number; diagnosticBefore:number; limit:number }; output: { attempts:number; diagnostics:number; sessions:number; more:boolean } };
  deleteAccount: { input: { playerId:string; now:number }; output: { sessions:string[]; attempts:number } };
  latestSubmission: { input: { attemptId:string; playerId:string; phaseId:string }; output: {receipt:StoredReceipt;action:PhaseAction}|null };
  touchAttempt: { input: { id:string; playerId:string; expectedRevision:number; idleBefore:number; now:number }; output: StoredAttempt };
  beginPhase: { input: { id: string; playerId: string; expectedRevision: number; phaseId: string; requestId: string; operationId: string; action: PhaseAction; idleBefore?:number; now: number }; output: { job: PhaseJob; receipt: StoredReceipt; duplicate: boolean } };
  phaseJob: { input: { operationId: string }; output: PhaseJob | null };
  pendingPhaseJobs: { input: {}; output: PhaseJob[] };
  saveDecisions: { input: { fence: PhaseFence; decisions: PhaseDecisions; now: number }; output: PhaseJob };
  recoverPhase: { input: { fence: PhaseFence; now: number }; output: PhaseJob };
  commitPhase: { input: { fence: PhaseFence; board: BoardFixture; reports: PublicPhaseReport[]; finished: boolean; now: number }; output: StoredAttempt };
  terminateAttempt: { input: { id: string; playerId: string; lifecycle: 'ABANDONED' | 'EXPIRED' | 'STOPPED'; idleBefore?:number; now: number }; output: StoredAttempt };
  health: { input: {}; output: { schemaVersion: number; journalMode: string } };
  identity: { input: { provider: StoredPlayer['provider']; subject: string; displayName: string; now: number }; output: StoredPlayer };
  createSession: { input: { tokenHash: string; playerId: string; expiresAt: number; now: number }; output: null };
  session: { input: { tokenHash: string; now: number }; output: StoredSession | null };
  revokeSession: { input: { tokenHash: string; now: number }; output: null };
  banPlayer: { input: { playerId: string; now: number; banned: boolean }; output: { sessions: string[] } };
  registerChallenge: { input: StoredChallenge & { now: number }; output: null };
  challenge: { input: { id: string; version: number }; output: StoredChallenge | null };
  createAttempt: { input: { id: string; playerId: string; challengeId: string; challengeVersion: number; now: number; reconnectTokenHash: string }; output: StoredAttempt };
  attempt: { input: { id: string; playerId?: string }; output: StoredAttempt | null };
  activeAttempts: { input: {}; output: StoredAttempt[] };
  receipt: { input: { attemptId: string; playerId: string; requestId: string }; output: StoredReceipt | null };
  recordReceipt: { input: StoredReceipt; output: StoredReceipt };
  checkpoint: { input: { id: string; expectedRevision: number; expectedPhaseId: string; board: BoardFixture; execution: AttemptExecution; lifecycle: AttemptLifecycle; reports: PublicPhaseReport[]; receipt?: StoredReceipt; now: number }; output: StoredAttempt };
  reports: { input: { attemptId: string }; output: PublicPhaseReport[] };
  backup: { input: { destination: string }; output: { pages: number } };
  close: { input: {}; output: null };
}
export type StoreOperation = keyof StoreOperations;
export type StoreRequest = { [K in StoreOperation]: { id: number; operation: K; input: StoreOperations[K]['input'] } }[StoreOperation];
export type StoreErrorCode = 'STORE_UNAVAILABLE' | 'STORE_BUSY' | 'STORE_CONFLICT' | 'STORE_FORBIDDEN' | 'STORE_INVALID' | 'STORE_SCHEMA' | 'CAPACITY_FULL' | 'ACTIVE_ATTEMPT_EXISTS' | 'DAILY_LIMIT';
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string) { super(message); this.name = 'StoreError'; }
}
