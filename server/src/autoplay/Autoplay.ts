import { createHash } from 'node:crypto';
import { ALL_POWERS, TERRITORIES, type GameRecord, type Power } from '@diplomacy/shared';
import { AttemptService } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { gameRecord } from '../challenge/PlaytestLog.js';
import type { ChallengeDefinition } from '../challenge/TunisPilot.js';
import { FULL_GAME_UNIT_INSTRUCTIONS } from '../providers/OpponentInstructions.js';
import { scriptedHumanAction } from '../evaluation/ScriptedPlayer.js';
import { canonicalJson, exportBoard, type BoardFixture } from '../fixtures/BoardFixture.js';
import type { ScenarioFixture } from '../fixtures/ScenarioFixture.js';
import { GameRoom } from '../GameRoom.js';
import { CONTEXT_VERSION } from '../luna/Context.js';
import { LunaDecisionError, LunaDecisionProvider } from '../luna/LunaDecisionProvider.js';
import type { LunaTransport } from '../luna/Transport.js';
import { OPPONENT_CONTRACTS, opponentContract, type OpponentContract } from '../providers/OpponentContract.js';
import { EFFORTS, type Effort } from '../providers/LunaPreset.js';
import { mixedPlan } from '../providers/OpponentPlan.js';
import { hashToken, type Store } from '../storage/Store.js';
import type { StoredAttempt } from '../storage/contracts.js';

export type ModelKey = OpponentContract['key'];
/** Luna and Haiku down the middle: with seven powers that is four and three. */
export const DEFAULT_ASSIGNMENT: Readonly<Record<Power, ModelKey>> = Object.freeze({
  AUSTRIA: 'luna', ENGLAND: 'haiku', FRANCE: 'luna', GERMANY: 'haiku', ITALY: 'luna', RUSSIA: 'haiku', TURKEY: 'luna' });
/**
 * The furthest a game may be asked to run. It is not a planning horizon: a game "to a win" simply
 * names this year. Reached only by a game that never produces a winner.
 */
export const FIRST_YEAR = 1901, LATEST_LAST_YEAR = 1999;
/**
 * One full-game call may take this long. The challenge's presets pin 20 seconds for a visitor who is
 * waiting; an unattended game would rather wait than leave a call's outcome unknown and its cost held.
 */
export const CALL_TIMEOUT_MS = 40_000;
/** Messages, replies and orders, each with room for a retry at the longer call limit. */
const PHASE_TIMEOUT_MS = 300_000;
/** More reasoning takes longer: the call and phase limits at each effort. */
export const EFFORT_LIMITS: Readonly<Record<Effort, { callMs: number; phaseMs: number }>> = Object.freeze({
  low: { callMs: CALL_TIMEOUT_MS, phaseMs: PHASE_TIMEOUT_MS }, medium: { callMs: 90_000, phaseMs: 600_000 }, high: { callMs: 120_000, phaseMs: 600_000 } });

/** The standing orders instructions a game is played under, and a short fingerprint to compare games by. */
export const harnessInstructions = () => ({ ordersInstructions: FULL_GAME_UNIT_INSTRUCTIONS,
  instructionsHash: createHash('sha256').update(FULL_GAME_UNIT_INSTRUCTIONS).digest('hex').slice(0,16) });

/**
 * How many years have passed with no supply center changing hands, counted back from the latest
 * settled phase. Ownership only changes after a Fall turn, so this is whole years.
 */
export function quietYears(reports: ReadonlyArray<{ year: number; after: { territoryOwners: unknown } }>): number {
  const last = reports.at(-1);
  if (!last) return 0;
  const owners = canonicalJson(last.after.territoryOwners);
  let since = last.year;
  for (let i = reports.length - 1; i >= 0 && canonicalJson(reports[i].after.territoryOwners) === owners; i--) since = reports[i].year;
  return last.year - since;
}

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
  /** Further tries for a message call that failed, before that power stays silent for the turn (0–3, default 2). */
  messageRetries?: number;
  /** Orders calls one power may use for one phase, across every run (3–10, default 6). Raise it to continue a game stuck on unusable answers. */
  orderCalls?: number;
  /** Explicit recoveries allowed for one phase in this run before the game is left waiting. */
  maxRecoveries?: number;
  /** Stop cleanly after this many phases in this run (the game stays resumable). */
  maxPhases?: number;
  /** How many times one phase waits out a provider that cannot be reached before the run stops (default 12, about ten minutes). */
  maxWaits?: number;
  /** When a power's own moves block each other, say which and ask once more; the second answer stands (default on). */
  askAgainWhenBlocked?: boolean;
  /** The reasoning effort every request is sent at (default low, as in the challenge). A game keeps one effort throughout. */
  effort?: Effort;
  /**
   * End the game once no supply center has changed hands for this many years. Unset or 0: never.
   * The game itself is left as it stands, so it can be continued with a larger number or none.
   */
  stalemateYears?: number;
  /** The code this run is played with, when the caller can tell (the CLI asks git). Recorded, never interpreted. */
  harness?: { commit: string | null; modified: boolean };
  /** Test seam for the pause between tries when a provider refuses requests before they are sent. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}
export interface AutoplayResult {
  run: { runId: string; attemptId: string; transport: 'mock' | 'live'; lastYear: number; talkRecipients: number; assignment: Record<Power, string>; planId: string; contextVersion: string;
    /** What the game was played under: code commit (null when unknown), whether harness files differed from it, and the standing orders instructions. A continued game states the latest run's. Absent when a stored game is described rather than played: what it was played under is not stored. */
    harness?: { commit: string | null; modified: boolean; instructionsHash: string; ordersInstructions: string; callTimeoutMs: number; stalemateYears: number; askAgainWhenBlocked: boolean; effort: Effort } };
  status: 'FINISHED' | 'WAITING' | 'PAUSED';
  /** How a finished game ended: one power reached 18 supply centers, the last year's Fall settled, or no center changed hands for the stated number of years. */
  endedBy: 'SOLO_WIN' | 'LAST_YEAR' | 'STALEMATE' | null;
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
  const talkRecipients = options.talkRecipients ?? 3, maxRecoveries = options.maxRecoveries ?? 5;
  if (!Number.isSafeInteger(talkRecipients) || talkRecipients < 0 || talkRecipients > 6) throw new Error('Powers may write to between 0 and 6 others.');
  if (!Number.isSafeInteger(maxRecoveries) || maxRecoveries < 0 || maxRecoveries > 10) throw new Error('Recovery limit must be between 0 and 10.');
  const stalemateYears = options.stalemateYears ?? 0;
  if (!Number.isSafeInteger(stalemateYears) || stalemateYears < 0 || stalemateYears > 99) throw new Error('The stalemate limit must be between 0 and 99 years.');
  const effort = options.effort ?? 'low';
  if (!EFFORTS.includes(effort)) throw new Error('Reasoning effort must be low, medium or high.');
  const limits = EFFORT_LIMITS[effort];
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
  // Each call reserved the worst case at the output ceiling of its effort, so the last one says which effort the game was played at.
  const lastCall = attempt ? (await store.call('providerCallsForAttempt',{ attemptId: attempt.id })).filter(c => c.role !== 'CHAT').sort((a,b) => b.createdAt - a.createdAt)[0] : undefined;
  if (lastCall) {
    const contract = plan.contractFor(lastCall.power);
    if (lastCall.maxCostNanousd !== contract.reservationNanousd(contract.preset.maxInputTokens,contract.fullGameOutputTokens[effort]))
      throw new Error('This run was played at a different reasoning effort. Continue it with the same --effort, or choose a new run ID.');
  }
  // Checked here, before anything is created: starting against an empty or paused ledger would otherwise pause it for everything.
  if ((await store.call('paidState',{})).stopped) throw new Error('Sponsored play is paused in this database (a grant ran out, or it was paused). Record a grant if needed, then run again with --resume-paid.');
  const funds = await store.call('fundingTotals',{});
  if (!attempt && funds.availableNanousd < plan.reservationNanousd * plan.maxConcurrentDecisions)
    throw new Error('Not enough funds to start. Record a funding grant first: npm run storage -- grant DATABASE <usd> <your-reference>');
  // A provider with a budget of its own must be able to pay for a phase's worth of its own calls too.
  for (const contract of plan.contracts) {
    const budget = funds.providers[contract.preset.provider];
    if (!attempt && budget && budget.availableNanousd < contract.reservationNanousd(contract.preset.maxInputTokens) * plan.maxConcurrentDecisions)
      throw new Error(`Not enough left in the ${contract.preset.provider === 'OPENAI' ? 'OpenAI' : 'Anthropic'} budget to start. Record a grant for it: npm run storage -- grant DATABASE <usd> <your-reference> ${contract.preset.provider.toLowerCase()}`);
  }
  attempt ??= await store.call('createAttempt',{ id, playerId: player.id, challengeId: definition.id, challengeVersion: definition.version, now: now(), reconnectTokenHash: hashToken(id),
    sponsored: { preset: { id: plan.id, pricingVersion: plan.pricingVersion }, minimumAvailableNanousd: plan.reservationNanousd } });

  const rules = new PhaseRules(), failures: Array<{ at: number; phaseId: string; reason: string }> = [];
  const main = options.transports[plan.contracts[0].key]!;
  const orderCalls = options.orderCalls ?? 6;
  if (!Number.isSafeInteger(orderCalls) || orderCalls < 3 || orderCalls > 10) throw new Error('A power may have between 3 and 10 orders calls for a phase.');
  const turn = (phaseId: string) => phaseId.split(':').slice(-3,-1).reverse().join(' ');
  const provider = new LunaDecisionProvider(store,rules,main,{ now, plan, transports: options.transports, maxCallsPerPower: orderCalls, timeoutMs: limits.callMs, askAgainWhenSelfBlocked: options.askAgainWhenBlocked ?? true, effort,
    onRejectedDecision: f => {
      const reason = `${f.power} orders call, try ${f.attempt}: answer not usable — ${f.reason}`;
      failures.push({ at: now(), phaseId: f.phaseId, reason }); log(`  ! ${turn(f.phaseId)} · ${reason}`);
    }, ...(talkRecipients ? { talk: { maxRecipients: talkRecipients, retries: options.messageRetries ?? 2,
    onFailure: f => {
      const reason = `${f.power} ${f.round === 'ASK' ? 'message' : 'reply'} call, try ${f.attempt}: ${f.reason}${f.final ? ' — gave up; it says nothing this turn' : ' — trying again'}`;
      failures.push({ at: now(), phaseId: f.phaseId, reason }); log(`  ! ${f.phaseId.split(':').slice(-3,-1).reverse().join(' ')} · ${reason}`);
    } } } : {}) });
  // Three rounds of calls (messages, replies, orders) share one phase deadline.
  let seen = (await store.call('reports',{ attemptId: id })).length, played = 0, quiet = 0;
  // Printed as each phase is committed. One submission can settle several phases in a row (those that ask
  // nothing of the nominal seat follow on their own), so waiting for the submission to return would hold
  // the lines back and show them all with one total.
  const announce = async () => {
    const reports = await store.call('reports',{ attemptId: id });
    for (const report of reports.slice(seen)) {
      played++;
      const spent = await store.call('attemptFunding',{ attemptId: id }), c = centers({ territoryOwners: report.after.territoryOwners } as BoardFixture);
      log(`${report.season} ${report.year} ${report.phase} · ${ALL_POWERS.map(p => `${p.slice(0,3)} ${c[p]}`).join(' ')} · ${usd(spent.settledNanousd)} spent${spent.heldNanousd ? `, ${usd(spent.heldNanousd)} held` : ''}`);
    }
    seen = reports.length; quiet = quietYears(reports);
  };
  const service = new AttemptService(store,provider,rules,{ now, maxRunning: 1, timeoutMs: limits.phaseMs,
    boundary: async stage => { if (stage === 'committed') await announce().catch(() => {}); },
    onPhaseFailure: (job,error) => failures.push({ at: now(), phaseId: job.phaseId,
      // Never the raw error: it may carry request content.
      reason: error instanceof LunaDecisionError ? `${error.power}: ${error.code}${error.detail ? ` (${error.detail})` : ''}` : error instanceof Error && /deadline/i.test(error.message) ? `The phase ran past its ${limits.phaseMs / 60_000}-minute deadline.` : 'The phase was interrupted.' }) });
  const recoveries = new Map<string, number>(), waits = new Map<string, number>(), maxWaits = options.maxWaits ?? 12;
  let status: AutoplayResult['status'] = 'FINISHED', waitingOn: string | null = null, stalemate = false;
  try {
    quiet = quietYears(await store.call('reports',{ attemptId: id }));
    while (attempt.lifecycle === 'ACTIVE') {
      // Checked between phases and from the stored reports, so a continued run reaches the same verdict without buying anything.
      if (stalemateYears && quiet >= stalemateYears && attempt.execution === 'ACCEPTING') { stalemate = true; log(`No supply center has changed hands for ${quiet} years: ending the game as a stalemate.`); break; }
      if (options.signal?.aborted) { status = 'PAUSED'; waitingOn = 'Stopped by you. Run it again with the same run ID to continue.'; break; }
      if (options.maxPhases !== undefined && played >= options.maxPhases) { status = 'PAUSED'; waitingOn = `Stopped after ${played} phases as asked. Run it again with the same run ID to continue.`; break; }
      const before: StoredAttempt = attempt;
      if (before.execution === 'ACCEPTING') {
        const action = await scriptedHumanAction(rules,before.board,definition.humanPower,NO_SCRIPT,'');
        await service.submit({ attemptId: id, playerId: player.id, revision: before.revision, phaseId: before.phaseId, requestId: `auto-${runId}-${before.revision}`, action });
      } else {
        // Left undecided by an earlier run or by a failed call: an explicit, counted recovery. Saved answers are reused.
        const used = recoveries.get(before.phaseId) ?? 0;
        // A request refused before it was sent cost nothing, so waiting it out does not use up the recoveries;
        // it has its own, longer patience.
        const unsent = /PREFLIGHT/.test(failures.at(-1)?.reason ?? '') && failures.at(-1)?.phaseId === before.phaseId;
        const waited = waits.get(before.phaseId) ?? 0;
        if (unsent ? waited >= maxWaits : used >= maxRecoveries) {
          status = 'WAITING';
          const paid = await store.call('paidState',{});
          waitingOn = paid.stopped ? 'Sponsored play is stopped: a budget is used up (the pool, or a provider\'s own; npm run storage -- funding shows which), or it was paused. Add a grant, then run again with the same run ID and --resume-paid.'
            : unsent ? `${before.phaseId.split(':').slice(-3).join(' ')}: the provider could not be reached or refused requests ${waited + 1} times over several minutes (${failures.at(-1)!.reason}). Nothing was billed for those. Check your connection and the provider's status, then run again with the same run ID.`
            : `${before.phaseId.split(':').slice(-3).join(' ')} could not be decided after ${used} recover${used === 1 ? 'y' : 'ies'}: ${failures.at(-1)?.reason ?? 'no reason recorded'}. ${
              /CALL_LIMIT/.test(failures.at(-1)?.reason ?? '') ? `That power has used all ${orderCalls} of its orders calls for this phase; run again with the same run ID and a higher --order-calls to give it more.` : 'Run again with the same run ID to try again.'}`;
          break;
        }
        // A provider that is refusing requests before they are sent (rate limit, quota, outage) is not helped by asking faster.
        if (unsent) {
          const seconds = Math.min(60,5 * 2 ** waited);
          waits.set(before.phaseId,waited + 1);
          log(`  … the provider refused the request before it was sent (${failures.at(-1)!.reason}); waiting ${seconds} s before trying again`);
          await (options.sleep ?? (ms => new Promise<void>(done => setTimeout(done,ms))))(seconds * 1000);
        }
        else recoveries.set(before.phaseId,used + 1);
        await service.recover(id);
      }
      await service.wait(id);
      attempt = (await store.call('attempt',{ id }))!;
      await announce();
    }
  } finally { await service.close(); }

  attempt = (await store.call('attempt',{ id }))!;
  const models = Object.fromEntries(ALL_POWERS.map(p => [p,plan.contractFor(p).preset.model])) as Record<Power, string>;
  return gameResult(store,attempt,challenge,failures,now(),{
    run: { runId, attemptId: id, transport: options.transportKind, lastYear: options.lastYear, talkRecipients, assignment: models, planId: plan.id, contextVersion: CONTEXT_VERSION,
      harness: { commit: options.harness?.commit ?? null, modified: options.harness?.modified ?? false, ...harnessInstructions(), callTimeoutMs: limits.callMs, stalemateYears, askAgainWhenBlocked: options.askAgainWhenBlocked ?? true, effort } },
    status: attempt.lifecycle === 'ACTIVE' && !stalemate ? (status === 'FINISHED' ? 'WAITING' : status) : 'FINISHED',
    stalemate, waitingOn });
}

/** The record and summary of one game as it stands in the database. */
async function gameResult(store: Store, attempt: StoredAttempt, challenge: NonNullable<Awaited<ReturnType<Store['call']>>> & { definition: ChallengeDefinition },
    failures: ReadonlyArray<{ at: number; phaseId: string; reason: string }>, now: number,
    meta: { run: AutoplayResult['run']; status: AutoplayResult['status']; stalemate: boolean; waitingOn: string | null }): Promise<AutoplayResult> {
  const record = await gameRecord(store,attempt,challenge as never,meta.run.assignment,failures,now);
  const funding = await store.call('attemptFunding',{ attemptId: attempt.id }), count = centers(attempt.board);
  const decisionCalls = record.phases.flatMap(p => p.calls), talkCalls = record.phases.flatMap(p => p.talk ?? []);
  const peak = (values: Array<number | null>) => Math.max(0,...values.map(v => v ?? 0));
  return {
    run: meta.run,
    status: meta.status,
    endedBy: meta.stalemate ? 'STALEMATE' : attempt.lifecycle === 'ACTIVE' ? null : ALL_POWERS.some(p => count[p] >= 18) ? 'SOLO_WIN' : 'LAST_YEAR',
    waitingOn: attempt.lifecycle === 'ACTIVE' ? meta.waitingOn : null,
    summary: { phases: record.phases.filter(p => p.report).length, year: attempt.board.year, season: attempt.board.season, centers: count,
      winner: ALL_POWERS.find(p => count[p] >= 18) ?? null,
      calls: decisionCalls.length, validCalls: decisionCalls.filter(c => c.outcome === 'VALID').length, talkCalls: talkCalls.length, messages: talkCalls.reduce((sum,c) => sum + c.messages.length,0),
      settledNanousd: funding.settledNanousd, heldNanousd: funding.heldNanousd,
      peakInputTokens: { orders: peak(decisionCalls.map(c => c.inputTokens)), ask: peak(talkCalls.filter(c => c.round === 'ASK').map(c => c.inputTokens)), reply: peak(talkCalls.filter(c => c.round === 'REPLY').map(c => c.inputTokens)) } },
    record,
  };
}

/** How a game in the database was set up, read back from its own calls (it is stored nowhere else). */
export interface GameSettings { assignment: Record<Power, ModelKey>; lastYear: number; effort: Effort; transport: 'mock' | 'live'; talkRecipients: number }

/**
 * Any full game in the database as a record, whether it is running, paused or finished: what the
 * development server's game pages show. Its settings are read back from its calls: each power's
 * model from its latest call, the effort from the worst case that call reserved, stand-in models
 * from their answers' ids, the message limit from the most any power wrote in one turn.
 */
export async function describeGame(store: Store, runId: string, extra: { failures?: ReadonlyArray<{ at: number; phaseId: string; reason: string }>; now?: number } = {}): Promise<(AutoplayResult & { settings: GameSettings }) | null> {
  if (!/^[a-z0-9-]{3,40}$/.test(runId)) return null;
  const attempt = await store.call('attempt',{ id: `auto-${runId}` });
  if (!attempt) return null;
  const challenge = await store.call('challenge',{ id: attempt.challengeId, version: attempt.challengeVersion });
  if (!challenge) return null;
  const calls = (await store.call('providerCallsForAttempt',{ attemptId: attempt.id })).filter(c => c.role !== 'CHAT').sort((a,b) => a.createdAt - b.createdAt);
  const keyOf = (model: string) => (Object.keys(OPPONENT_CONTRACTS) as ModelKey[]).find(k => OPPONENT_CONTRACTS[k].preset.model === model) ?? 'luna';
  const assignment = Object.fromEntries(ALL_POWERS.map(p => [p,keyOf(calls.filter(c => c.power === p).at(-1)?.model ?? '')])) as Record<Power, ModelKey>;
  const last = calls.at(-1), contract = last ? OPPONENT_CONTRACTS[keyOf(last.model)] : undefined;
  const effort = (contract && EFFORTS.find(e => contract.reservationNanousd(contract.preset.maxInputTokens,contract.fullGameOutputTokens[e]) === last!.maxCostNanousd)) ?? 'low';
  const transport = calls.some(c => /^(resp|msg)_mock_/.test(c.responseId ?? '')) ? 'mock' : 'live';
  const talks = await store.call('powerTalks',{ attemptId: attempt.id });
  const talkRecipients = Math.max(0,...talks.filter(t => t.kind === 'ASK').map(t => t.messages.length)) || 3;
  const lastYear = Number(/^full-game-to-(\d{4})$/.exec(attempt.challengeId)?.[1] ?? LATEST_LAST_YEAR);
  const models = Object.fromEntries(ALL_POWERS.map(p => [p,OPPONENT_CONTRACTS[assignment[p]].preset.model])) as Record<Power, string>;
  const result = await gameResult(store,attempt,challenge as never,extra.failures ?? [],extra.now ?? Date.now(),{
    run: { runId, attemptId: attempt.id, transport, lastYear, talkRecipients, assignment: models, planId: attempt.preset?.id ?? '', contextVersion: CONTEXT_VERSION },
    status: attempt.lifecycle === 'ACTIVE' ? 'PAUSED' : 'FINISHED', stalemate: false, waitingOn: null });
  return { ...result, settings: { assignment, lastYear, effort, transport, talkRecipients } };
}
