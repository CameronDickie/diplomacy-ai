import { ALL_POWERS } from '@diplomacy/shared';
import { botAction } from '../attempts/PracticeBot.js';
import type { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseDecisions, PhaseJob } from '../attempts/types.js';
import type { Store } from '../storage/Store.js';
import { StoreError, type StoredExhibition } from '../storage/contracts.js';

interface Options {
  now?: () => number;
  /** Phases resolved per game per tick, so one tick is short and other work is never starved. */
  stepsPerTick?: number;
  /** Consecutive phases with no change of ownership or unit count before a game is called a draw. */
  quietLimit?: number;
  timeoutMs?: number;
}
/**
 * Advances bot-only exhibition games from a timer, never from a request. All seven powers are the
 * practice bot, so a game makes no provider call and costs nothing. SQLite holds the position and
 * the phase count; this object holds no game state, so a restart simply continues.
 */
export class ExhibitionRunner {
  private ticking?: Promise<number>;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly failures = new Map<string, number>();
  private readonly controller = new AbortController();
  constructor(private store: Store, private rules: PhaseRules, private options: Options = {}) {}
  /** Resolves and commits one phase. Returns the stored game afterwards, or null if another commit got there first. */
  private async step(game: StoredExhibition): Promise<StoredExhibition | null> {
    const challenge = await this.store.call('challenge',{ id: game.challengeId, version: game.challengeVersion });
    if (!challenge) throw new Error('Scenario is no longer registered.');
    const signal = AbortSignal.any([this.controller.signal,AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]), now = (this.options.now ?? Date.now)();
    // Seeded from the game and its phase number: a phase replayed after a crash is decided identically.
    const actions: PhaseDecisions = {};
    for (const power of ALL_POWERS) actions[power] = await botAction(this.rules,game.board,power,signal,game.id,String(game.phases));
    const human = challenge.definition.humanPower, { [human]: humanAction, ...decisions } = actions;
    const job: PhaseJob = { operationId: `${game.id}:${game.phases + 1}`, attemptId: game.id, phaseId: `${game.id}:${game.phases}`, revision: game.phases, status: 'RESOLVING', playerId: 'exhibition', requestId: 'exhibition',
      board: game.board, definition: challenge.definition, humanAction: humanAction!, decisions, reportOffset: game.phases, createdAt: now };
    const resolved = await this.rules.resolve(job,signal);
    try {
      return await this.store.call('advanceExhibition',{ id: game.id, expectedPhases: game.phases, board: resolved.board, report: resolved.reports[0], finished: resolved.finished, quietLimit: this.options.quietLimit ?? 16, now });
    } catch (error) {
      // Paused, cancelled or already advanced while this phase was being resolved: drop the result.
      if (error instanceof StoreError && error.code === 'STORE_CONFLICT') return null;
      throw error;
    }
  }
  /** Runs every running game forward a little. Returns how many phases were committed. */
  tick(): Promise<number> {
    if (this.closed) return Promise.resolve(0);
    this.ticking ??= this.run().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async run(): Promise<number> {
    let committed = 0;
    for (const listed of await this.store.call('exhibitions',{ state: 'RUNNING', limit: 10 })) {
      let game: StoredExhibition | null = listed;
      for (let n = 0; game && game.state === 'RUNNING' && n < (this.options.stepsPerTick ?? 2) && !this.closed; n++) {
        try {
          game = await this.step(game);
          if (game) { committed++; this.failures.delete(game.id); }
        } catch {
          // Three failures in a row end the game as failed rather than retrying forever.
          const count = (this.failures.get(listed.id) ?? 0) + 1;
          this.failures.set(listed.id,count);
          if (count >= 3 && !this.closed) await this.store.call('setExhibitionState',{ id: listed.id, action: 'FAIL', now: (this.options.now ?? Date.now)() }).catch(() => {});
          game = null;
        }
      }
    }
    return committed;
  }
  start(intervalMs = 2_000): void {
    this.timer = setInterval(() => { void this.tick().catch(() => {}); },intervalMs);
    this.timer.unref();
  }
  async close(): Promise<void> { this.closed = true; clearInterval(this.timer); this.controller.abort(); await this.ticking?.catch(() => {}); }
}
