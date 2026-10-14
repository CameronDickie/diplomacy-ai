import type { Power } from './game.js';
import type { GameRecord } from './challenge.js';

/** What a full game was played under, as stamped into its record. Absent from records made before the stamp existed. */
export interface AutoplayHarness {
  commit: string | null; modified: boolean; instructionsHash: string; ordersInstructions: string;
  callTimeoutMs: number; stalemateYears: number; askAgainWhenBlocked?: boolean;
}
/** One file the autoplay tool wrote for a game; a game continued over several runs has several. */
export interface AutoplayPart { file: string; exportedAt: string; status: string; commit: string | null; instructionsHash: string | null; failures: number }
/**
 * A model-only full game as the autoplay tool exports it (development only). `parts` is added when the
 * records tool combines the files of one game: the latest file's phases, with every file's failures.
 */
export interface AutoplayGameFile {
  run: { runId: string; attemptId: string; transport: 'mock' | 'live'; lastYear: number; talkRecipients: number; assignment: Record<Power, string>;
    planId: string; contextVersion: string; harness?: AutoplayHarness };
  status: 'FINISHED' | 'WAITING' | 'PAUSED';
  endedBy: 'SOLO_WIN' | 'LAST_YEAR' | 'STALEMATE' | null;
  waitingOn: string | null;
  summary: { phases: number; year: number; season: string; centers: Record<Power, number>; winner: Power | null;
    calls: number; validCalls: number; talkCalls: number; messages: number; settledNanousd: number; heldNanousd: number;
    peakInputTokens: { orders: number; ask: number; reply: number } };
  record: GameRecord;
  parts?: AutoplayPart[];
}
/** One line of the viewer's list of games. */
export interface AutoplayIndexEntry {
  runId: string; file: string; bytes: number; transport: 'mock' | 'live'; assignment: Record<Power, string>; lastYear: number;
  status: AutoplayGameFile['status']; endedBy: AutoplayGameFile['endedBy']; reached: string; phases: number;
  centers: Record<Power, number>; winner: Power | null; settledNanousd: number; heldNanousd: number;
  instructionsHashes: string[]; commits: string[]; parts: number; failures: number; exportedAt: string;
}
