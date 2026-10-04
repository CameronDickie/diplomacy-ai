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
export interface StoreOperations {
  health: { input: {}; output: { schemaVersion: number; journalMode: string } };
  identity: { input: { provider: StoredPlayer['provider']; subject: string; displayName: string; now: number }; output: StoredPlayer };
  createSession: { input: { tokenHash: string; playerId: string; expiresAt: number; now: number }; output: null };
  session: { input: { tokenHash: string; now: number }; output: StoredSession | null };
  revokeSession: { input: { tokenHash: string; now: number }; output: null };
  banPlayer: { input: { playerId: string; now: number; banned: boolean }; output: null };
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
export type StoreErrorCode = 'STORE_UNAVAILABLE' | 'STORE_BUSY' | 'STORE_CONFLICT' | 'STORE_FORBIDDEN' | 'STORE_INVALID' | 'STORE_SCHEMA';
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string) { super(message); this.name = 'StoreError'; }
}
