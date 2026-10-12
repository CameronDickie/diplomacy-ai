import { createHash } from 'node:crypto';
import { ALL_POWERS, TERRITORIES, type GameRecord, type Power } from '@diplomacy/shared';
import { AttemptService } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { gameRecord } from '../challenge/PlaytestLog.js';
import type { ChallengeDefinition } from '../challenge/TunisPilot.js';
import { scriptedHumanAction } from '../evaluation/ScriptedPlayer.js';
import { canonicalJson, exportBoard, type BoardFixture } from '../fixtures/BoardFixture.js';
import type { ScenarioFixture } from '../fixtures/ScenarioFixture.js';
import { GameRoom } from '../GameRoom.js';
import { CONTEXT_VERSION } from '../luna/Context.js';
import { LunaDecisionError, LunaDecisionProvider } from '../luna/LunaDecisionProvider.js';
import type { LunaTransport } from '../luna/Transport.js';
import { opponentContract, type OpponentContract } from '../providers/OpponentContract.js';
import { mixedPlan } from '../providers/OpponentPlan.js';
import { hashToken, type Store } from '../storage/Store.js';
import type { StoredAttempt } from '../storage/contracts.js';

export type ModelKey = OpponentContract['key'];
/** Luna and Haiku down the middle: with seven powers that is four and three. */
export const DEFAULT_ASSIGNMENT: Readonly<Record<Power, ModelKey>> = Object.freeze({
  AUSTRIA: 'luna', ENGLAND: 'haiku', FRANCE: 'luna', GERMANY: 'haiku', ITALY: 'luna', RUSSIA: 'haiku', TURKEY: 'luna' });
export const FIRST_YEAR = 1901, LATEST_LAST_YEAR = 1925;

export interface AutoplayOptions {
  store: Store;
  /** Names the game. Running again with the same id continues it; nothing already bought is bought again. */
  runId: string;
  /** The game ends once this year's Fall has settled, or earlier on a solo win. */
  lastYear: number;
  assignment?: Readonly<Record<Power, ModelKey>>;
  /** One transport per model in use. */
  transports: Partial<Record<ModelKey, LunaTransport>>;
  transportKind: 'mock' | 'live';
  /** How many other powers each power may write to before orders. 0 turns messages off. */
  talkRecipients?: number;
  /** Explicit recoveries allowed for one phase in this run before the game is left waiting. */
  maxRecoveries?: number;
  /** Stop cleanly after this many phases in this run (the game stays resumable). */
  maxPhases?: number;
  now?: () => number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}
export interface AutoplayResult {
  run: { runId: string; attemptId: string; transport: 'mock' | 'live'; lastYear: number; talkRecipients: number; assignment: Record<Power, string>; planId: string; contextVersion: string };
  status: 'FINISHED' | 'WAITING' | 'PAUSED';
  /** Why the game is not finished, in plain words. Null when it is. */
  waitingOn: string | null;
  summary: {
    phases: number; year: number; season: string; centers: Record<Power, number>; winner: Power | null;
    calls: number; validCalls: number; talkCalls: number; messages: number; settledNanousd: number; heldNanousd: number;
    /** Largest request seen so far, by provider-counted input tokens, for each kind of call. */
    peakInputTokens: { orders: number; ask: number; reply: number };
  };
  record: GameRecord;
}

/** The standard opening with every seat given to a model. The objective's territory is unused; only its year matters. */
export function fullGameDefinition(lastYear: number): ChallengeDefinition {
  const id = `full-game-to-${lastYear}`;
  return { id, version: 1, title: 'Full game', objectiveText: `A full game with no human player, played to Fall ${lastYear} or a solo win.`,
    variant: 'CLASSICAL', startingPosition: { fixtureId: id, version: 1 }, rulesEngine: 'godip@v0.6.5',
    humanPower: 'AUSTRIA', opponentPowers: [...ALL_POWERS], opponentPolicy: 'SPONSORED_LUNA_UNRANKED',
    objective: { kind: 'OWN_SUPPLY_CENTER_AFTER_FALL', territory: 'VIE', deadlineYear: lastYear },
    earlyAchievementYear: lastYear, rotation: 'PILOT_ONLY', tiePolicy: 'NOT_POSSIBLE_SINGLE_OWNER', autoplay: true };
}
const centers = (board: BoardFixture) => Object.fromEntries(ALL_POWERS.map(p => [p,TERRITORIES.filter(t => t.isSupplyCenter && board.territoryOwners[t.id] === p).length])) as Record<Power, number>;
const usd = (nano: number) => `USD ${(nano / 1e9).toFixed(4)}`;
const NO_SCRIPT = { witnesses: [] } as unknown as ScenarioFixture;

/**
 * Plays one full game with a model on every power, through the same ledger, decision provider and
 * rules engine as a sponsored challenge attempt. Development only: it is reached from the autoplay
 * CLI on a local database and from nowhere else.
 *
 * The game is an ordinary attempt whose scenario lists all seven powers as model-played. Each phase
 * is opened with a placeholder action for the nominal seat, which the rules then ignore in favour of
 * that power's own model decision; no power is ever given a default in place of a decision.
 */
export async function autoplay(options: AutoplayOptions): Promise<AutoplayResult> {
  const { store, runId } = options, now = options.now ?? Date.now, log = options.log ?? (() => {});
  if (!/^[a-z0-9-]{3,40}$/.test(runId)) throw new Error('Run ID must be 3–40 lowercase letters, digits or dashes.');
  if (!Number.isSafeInteger(options.lastYear) || options.lastYear < FIRST_YEAR || options.lastYear > LATEST_LAST_YEAR) throw new Error(`The last year must be between ${FIRST_YEAR} and ${LATEST_LAST_YEAR}.`);
  const talkRecipients = options.talkRecipients ?? 3, maxRecoveries = options.maxRecoveries ?? 2;
  if (!Number.isSafeInteger(talkRecipients) || talkRecipients < 0 || talkRecipients > 6) throw new Error('Powers may write to between 0 and 6 others.');
  if (!Number.isSafeInteger(maxRecoveries) || maxRecoveries < 0 || maxRecoveries > 10) throw new Error('Recovery limit must be between 0 and 10.');
  const assignment = options.assignment ?? DEFAULT_ASSIGNMENT;
  if (ALL_POWERS.some(p => !assignment[p])) throw new Error('Every power needs a model.');
  const plan = mixedPlan(assignment,opponentContract(assignment.AUSTRIA));
  for (const contract of plan.contracts) if (!options.transports[contract.key]) throw new Error(`No transport was given for ${contract.key}.`);

  const definition = fullGameDefinition(options.lastYear);
  let challenge = await store.call('challenge',{ id: definition.id, version: definition.version });
  if (!challenge) {
    // A fresh room is the standard 1901 opening. Its board is stored once and reused, so a continued run sees the same units.
    const room = new GameRoom(), content = { definition, board: exportBoard(room.getState()) };
    room.dispose();
    await store.call('registerChallenge',{ ...content, hash: createHash('sha256').update(canonicalJson(content)).digest('hex'), now: now() });
    challenge = (await store.call('challenge',{ id: definition.id, version: definition.version }))!;
  }
  const player = await store.call('identity',{ provider: 'github', subject: `autoplay-${runId}`, displayName: 'Autoplay (no human)', now: now() });
  const id = `auto-${runId}`;
  let attempt = await store.call('attempt',{ id });
  if (attempt && (attempt.preset?.id !== plan.id || attempt.preset?.pricingVersion !== plan.pricingVersion))
    throw new Error('This run was started with different models or prices. Continue it with the same assignment, or choose a new run ID.');
  if (attempt && (attempt.challengeId !== definition.id)) throw new Error('This run was started with a different last year. Continue it with the same one, or choose a new run ID.');
  attempt ??= await store.call('createAttempt',{ id, playerId: player.id, challengeId: definition.id, challengeVersion: definition.version, now: now(), reconnectTokenHash: hashToken(id),
    sponsored: { preset: { id: plan.id, pricingVersion: plan.pricingVersion }, minimumAvailableNanousd: plan.reservationNanousd } });

  const rules = new PhaseRules(), failures: Array<{ at: number; phaseId: string; reason: string }> = [];
  const main = options.transports[plan.contracts[0].key]!;
  const provider = new LunaDecisionProvider(store,rules,main,{ now, plan, transports: options.transports, ...(talkRecipients ? { talk: { maxRecipients: talkRecipients } } : {}) });
  // Three rounds of calls (messages, replies, orders) share one phase deadline.
  const service = new AttemptService(store,provider,rules,{ now, maxRunning: 1, timeoutMs: 120_000,
    onPhaseFailure: (job,error) => failures.push({ at: now(), phaseId: job.phaseId,
      // Never the raw error: it may carry request content.
      reason: error instanceof LunaDecisionError ? `${error.power}: ${error.code}` : error instanceof Error && /deadline/i.test(error.message) ? 'The phase ran past its two-minute deadline.' : 'The phase was interrupted.' }) });
  const recoveries = new Map<string, number>();
  let seen = (await store.call('reports',{ attemptId: id })).length;
  let status: AutoplayResult['status'] = 'FINISHED', waitingOn: string | null = null, played = 0;
  try {
    while (attempt.lifecycle === 'ACTIVE') {
      if (options.signal?.aborted) { status = 'PAUSED'; waitingOn = 'Stopped by you. Run it again with the same run ID to continue.'; break; }
      if (options.maxPhases !== undefined && played >= options.maxPhases) { status = 'PAUSED'; waitingOn = `Stopped after ${played} phases as asked. Run it again with the same run ID to continue.`; break; }
      const before: StoredAttempt = attempt;
      if (before.execution === 'ACCEPTING') {
        const action = await scriptedHumanAction(rules,before.board,definition.humanPower,NO_SCRIPT,'');
        await service.submit({ attemptId: id, playerId: player.id, revision: before.revision, phaseId: before.phaseId, requestId: `auto-${runId}-${before.revision}`, action });
      } else {
        // Left undecided by an earlier run or by a failed call: an explicit, counted recovery. Saved answers are reused.
        const used = recoveries.get(before.phaseId) ?? 0;
        if (used >= maxRecoveries) {
          status = 'WAITING';
          const paid = await store.call('paidState',{});
          waitingOn = paid.stopped ? 'Sponsored play is stopped (the funding grant is used up, or it was paused). Add a grant or resume, then run again with the same run ID.'
            : `${before.phaseId.split(':').slice(-3).join(' ')} could not be decided after ${used} recover${used === 1 ? 'y' : 'ies'}: ${failures.at(-1)?.reason ?? 'no reason recorded'}. Run again with the same run ID to try again.`;
          break;
        }
        recoveries.set(before.phaseId,used + 1);
        await service.recover(id);
      }
      await service.wait(id);
      attempt = (await store.call('attempt',{ id }))!;
      // One submission can settle several phases (those that ask nothing of the nominal seat follow on their own).
      const reports = await store.call('reports',{ attemptId: id });
      for (const report of reports.slice(seen)) {
        played++;
        const spent = await store.call('attemptFunding',{ attemptId: id }), c = centers({ ...attempt.board, territoryOwners: report.after.territoryOwners } as BoardFixture);
        log(`${report.season} ${report.year} ${report.phase} · ${ALL_POWERS.map(p => `${p.slice(0,3)} ${c[p]}`).join(' ')} · ${usd(spent.settledNanousd)} spent${spent.heldNanousd ? `, ${usd(spent.heldNanousd)} held` : ''}`);
      }
      seen = reports.length;
    }
  } finally { await service.close(); }

  attempt = (await store.call('attempt',{ id }))!;
  const record = await gameRecord(store,attempt,challenge,Object.fromEntries(ALL_POWERS.map(p => [p,plan.contractFor(p).preset.model])),failures,now());
  const funding = await store.call('attemptFunding',{ attemptId: id }), count = centers(attempt.board);
  const decisionCalls = record.phases.flatMap(p => p.calls), talkCalls = record.phases.flatMap(p => p.talk ?? []);
  const peak = (values: Array<number | null>) => Math.max(0,...values.map(v => v ?? 0));
  return {
    run: { runId, attemptId: id, transport: options.transportKind, lastYear: options.lastYear, talkRecipients,
      assignment: Object.fromEntries(ALL_POWERS.map(p => [p,plan.contractFor(p).preset.model])) as Record<Power, string>, planId: plan.id, contextVersion: CONTEXT_VERSION },
    status: attempt.lifecycle === 'ACTIVE' ? (status === 'FINISHED' ? 'WAITING' : status) : 'FINISHED',
    waitingOn: attempt.lifecycle === 'ACTIVE' ? waitingOn : null,
    summary: { phases: record.phases.filter(p => p.report).length, year: attempt.board.year, season: attempt.board.season, centers: count,
      winner: ALL_POWERS.find(p => count[p] >= 18) ?? null,
      calls: decisionCalls.length, validCalls: decisionCalls.filter(c => c.outcome === 'VALID').length, talkCalls: talkCalls.length, messages: talkCalls.reduce((sum,c) => sum + c.messages.length,0),
      settledNanousd: funding.settledNanousd, heldNanousd: funding.heldNanousd,
      peakInputTokens: { orders: peak(decisionCalls.map(c => c.inputTokens)), ask: peak(talkCalls.filter(c => c.round === 'ASK').map(c => c.inputTokens)), reply: peak(talkCalls.filter(c => c.round === 'REPLY').map(c => c.inputTokens)) } },
    record,
  };
}
