import express, { type Response } from 'express';
import { ALL_POWERS, TERRITORIES, type Power } from '@diplomacy/shared';
import { keyVariable, liveTransport } from '../evaluation/cli.js';
import { mockOpponentTransport, type LunaTransport } from '../luna/Transport.js';
import { EFFORTS, type Effort } from '../providers/LunaPreset.js';
import { OPPONENT_CONTRACTS, opponentContract } from '../providers/OpponentContract.js';
import { Store } from '../storage/Store.js';
import { StoreError } from '../storage/contracts.js';
import { DEFAULT_ASSIGNMENT, LATEST_LAST_YEAR, autoplay, describeGame, type AutoplayResult, type ModelKey } from './Autoplay.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseAction } from '../attempts/types.js';
import type { BoardFixture } from '../fixtures/BoardFixture.js';
import type { HumanSeat } from '../luna/LunaDecisionProvider.js';
import { harnessVersion } from './cli.js';
import type { RuntimeConfig } from '../../../config/runtime.cjs';

export const fullGamesEnabled = (config: Pick<RuntimeConfig, 'profile' | 'production' | 'host'>): boolean =>
  config.profile === 'local' && !config.production && ['127.0.0.1','localhost','::1'].includes(config.host);

/** What starting (or continuing) a game asks for: the same choices as the autoplay command's flags. */
export interface StartRequest {
  runId: string; assignment?: Partial<Record<Power, ModelKey>>; until: number | 'win'; effort?: Effort; messages?: number;
  live?: boolean; authorizationRef?: string; attemptCapUsd?: number; resumePaid?: boolean; orderCalls?: number;
  /** A person plays this power; the game waits for them each phase. */
  seat?: Power;
}
/** What the person in a seat is being asked for right now, and how to hand their answer to the game. */
interface Pending { kind: 'TALK' | 'ACT'; operationId: string; phaseId: string; board?: BoardFixture; resolve: (value: never) => void }
/**
 * `lastOrders` is the latest request for orders, kept while the phase is played again after a refused model
 * answer (the request is withdrawn for that moment), and `ordersGiven` the person's orders by request, so
 * orders sent in that gap answer the request the phase is about to make instead of being refused.
 */
interface Run { controller: AbortController; log: string[]; startedAt: number; settings: StartRequest; pending: Pending | null; lastOrders: Pending | null; ordersGiven: Map<string, Promise<PhaseAction | null>> }
const LOG_LINES = 300;
type Kind = 'live' | 'standIn';
/** A request the service refuses, with a message fit to show. */
class RequestError extends Error {}

/**
 * Model-only full games inside the development server (local profile only), so a game can be started,
 * watched as it is played and stopped from the browser instead of the terminal. It plays exactly what
 * the autoplay command plays, against the same ledger database, one game at a time.
 *
 * Paid games keep the command's safeguards: they must be asked for explicitly, name a funding grant
 * that exists, and use provider keys from the server's own environment, which never leave it.
 *
 * Stand-in games (free, for trying things out) are kept in a separate database with pretend funds, so
 * their simulated costs never touch the real ledger and its provider budgets. A game stays in the
 * database it was started in: a stand-in game continues with stand-ins, a live game with live models.
 */
export class FullGameService {
  private stores: Record<Kind, Promise<Store> | null> = { live: null, standIn: null };
  private running: { runId: string; run: Run } | null = null;
  private starting = false;
  private completion: Promise<void> | null = null;
  /** The last run of each game this process played: its log, and how it ended, kept for its page. */
  private finished = new Map<string, { log: string[]; endedAt: number; error: string | null; result: Pick<AutoplayResult, 'status' | 'waitingOn' | 'endedBy'> | null; failures: AutoplayResult['record']['failures'] }>();
  private rules = new PhaseRules();
  constructor(private databasePath: string, private standInPath: string, private now: () => number = Date.now) {}

  private open(kind: Kind): Promise<Store> {
    return this.stores[kind] ??= Store.open(kind === 'live' ? this.databasePath : this.standInPath).then(async store => {
      // Pretend money for stand-in games: their costs are simulated, and this database holds nothing else.
      if (kind === 'standIn' && !(await store.call('fundingTotals',{})).grants) {
        await store.call('grantFunding',{ amountNanousd: 1_000_000_000_000, authorizationRef: 'stand-in-funds-0001', grantedBy: 'full-games-page', now: this.now() });
        await store.call('setFundingPolicy',{ attemptCapNanousd: 15_000_000_000, ceilingLimitNanousd: null, now: this.now() });
      }
      return store;
    });
  }
  async close(): Promise<void> {
    this.running?.run.controller.abort();
    await this.completion;
    for (const store of Object.values(this.stores)) if (store) await (await store).close();
  }
  /** Which database holds a game: the real ledger first, then the stand-in one. */
  private async locate(runId: string): Promise<Kind | null> {
    for (const kind of ['live','standIn'] as const) if (await (await this.open(kind)).call('attempt',{ id: `auto-${runId}` })) return kind;
    return null;
  }

  /** Every full game in the database, the funding that pays for them, and which keys this server holds. */
  async list() {
    const store = await this.open('live');
    const centers = (owners: Record<string, string | null>) => Object.fromEntries(ALL_POWERS.map(p => [p,TERRITORIES.filter(t => t.isSupplyCenter && owners[t.id] === p).length]));
    const games = (await Promise.all((['live','standIn'] as const).map(async kind => (await (await this.open(kind)).call('fullGames',{})).map(g => ({ runId: g.id.replace(/^auto-/,''), standIn: kind === 'standIn',
      lifecycle: g.lifecycle, year: g.year, season: g.season, phase: g.phase, centers: centers(g.territoryOwners),
      // The power a person plays, from the game's challenge id (`full-game-to-1999-seat-france`), or null.
      seat: (/-seat-([a-z]+)$/.exec(g.challengeId)?.[1].toUpperCase() ?? null) as Power | null, running: this.running?.runId === g.id.replace(/^auto-/,''),
      waiting: this.running?.runId === g.id.replace(/^auto-/,'') && Boolean(this.running.run.pending), createdAt: g.createdAt, updatedAt: g.updatedAt }))))).flat().sort((a,b) => a.createdAt - b.createdAt);
    const funding = await store.call('fundingTotals',{}), paid = await store.call('paidState',{});
    return { games, funding, paidStopped: paid.stopped, running: this.running?.runId ?? null,
      keys: { OPENAI: Boolean(process.env.OPENAI_API_KEY), ANTHROPIC: Boolean(process.env.ANTHROPIC_API_KEY) },
      models: Object.fromEntries(Object.entries(OPPONENT_CONTRACTS).map(([k,c]) => [k,{ model: c.preset.model, provider: c.preset.provider }])), defaultAssignment: DEFAULT_ASSIGNMENT };
  }

  /** One game as its page shows it: the record, how it was set up, and this process's live view of it. */
  async game(runId: string) {
    const kind = await this.locate(runId);
    if (!kind) return null;
    const store = await this.open(kind), running = this.running?.runId === runId ? this.running.run : null, last = this.finished.get(runId);
    // The last run's failures are known only to this process; the database keeps no list of them.
    const described = await describeGame(store,runId,{ failures: last?.failures.map(f => ({ ...f, at: Date.parse(f.at) })), now: this.now() });
    if (!described) return null;
    const pending = running?.pending ?? null;
    const live = { running: Boolean(running), log: running?.log ?? last?.log ?? [], startedAt: running?.startedAt ?? null, error: last?.error ?? null,
      // The person's part of the phase in hand, when the game is waiting for it.
      waitingFor: pending ? { kind: pending.kind, phaseId: pending.phaseId } : null,
      status: running ? 'RUNNING' : last?.result?.status ?? (described.status === 'FINISHED' ? 'FINISHED' : 'PAUSED'), waitingOn: running ? null : last?.result?.waitingOn ?? null };
    return { ...described, endedBy: last?.result?.endedBy ?? described.endedBy, standIn: kind === 'standIn', live };
  }

  /** Starts a new game or continues one; it plays in the background and its page follows it. */
  async start(request: StartRequest): Promise<{ runId: string }> {
    if (this.starting) throw new RequestError('A game is already starting. Wait for it to finish starting.');
    this.starting = true;
    try { return await this.startGame(request); }
    finally { this.starting = false; }
  }

  private async startGame(request: StartRequest): Promise<{ runId: string }> {
    if (this.running) throw new RequestError(`Game ${this.running.runId} is still being played. Stop it first.`);
    if (typeof request.runId !== 'string' || !/^[a-z0-9-]{3,40}$/.test(request.runId)) throw new RequestError('A game name is 3–40 lowercase letters, digits or dashes.');
    const lastYear = request.until === 'win' ? LATEST_LAST_YEAR : Number(request.until);
    if (!Number.isSafeInteger(lastYear) || lastYear < 1901 || lastYear > LATEST_LAST_YEAR) throw new RequestError('The last year must be between 1901 and 1999, or "win".');
    const effort = request.effort ?? 'low';
    if (!EFFORTS.includes(effort)) throw new RequestError('Reasoning effort must be low, medium or high.');
    const assignment = { ...DEFAULT_ASSIGNMENT, ...request.assignment } as Record<Power, ModelKey>;
    if (request.seat !== undefined && !ALL_POWERS.includes(request.seat)) throw new RequestError('Unknown power for your seat.');
    for (const p of ALL_POWERS) if (!Object.hasOwn(OPPONENT_CONTRACTS,assignment[p])) throw new RequestError(`Unknown model for ${p}.`);
    const messages = request.messages ?? 3, orderCalls = request.orderCalls ?? 6;
    if (!Number.isSafeInteger(messages) || messages < 0 || messages > 6) throw new RequestError('Powers may write to between 0 and 6 others.');
    if (!Number.isSafeInteger(orderCalls) || orderCalls < 3 || orderCalls > 10) throw new RequestError('A power may have between 3 and 10 orders calls for a phase.');
    const kind: Kind = request.live ? 'live' : 'standIn', elsewhere = await this.locate(request.runId);
    if (elsewhere && elsewhere !== kind) throw new RequestError(elsewhere === 'standIn' ? 'This is a stand-in game; it continues with stand-in models.' : 'This game was played with live models; it continues with live models.');
    const store = await this.open(kind);
    const transports: Partial<Record<ModelKey, LunaTransport>> = {};
    for (const key of new Set(Object.values(assignment))) {
      const contract = opponentContract(key);
      // A paid game needs the grant that authorizes it and the provider's key in this server's environment.
      transports[key] = request.live
        ? liveTransport({ live: true, db: this.databasePath, authorizationRef: request.authorizationRef, attempts: 1, apiKey: process.env[keyVariable(contract)], contract })!
        : mockOpponentTransport(contract,{ pick: 'seeded', seed: 1 });
    }
    if (request.attemptCapUsd !== undefined) {
      const cap = Math.round(Number(request.attemptCapUsd) * 1e9), totals = await store.call('fundingTotals',{});
      if (!Number.isSafeInteger(cap) || cap < 1) throw new RequestError('The per-game cap is an amount in USD.');
      await store.call('setFundingPolicy',{ attemptCapNanousd: cap, ceilingLimitNanousd: totals.ceilingNanousd < totals.grantedNanousd ? totals.ceilingNanousd : null, now: this.now() });
    }
    // Lifting a pause written when a budget ran out is the owner's decision, made by asking for it.
    if (request.resumePaid) await store.call('setPaidStopped',{ stopped: false, operatorId: 'full-games-page', now: this.now() });
    const run: Run = { controller: new AbortController(), log: [], startedAt: this.now(), settings: request, pending: null, lastOrders: null, ordersGiven: new Map() };
    // The person's seat: each request parks until their answer arrives through talk() or act() below. A game
    // stops only between phases, and this phase is waiting for the person, so Stop interrupts it instead;
    // continuing the game plays the phase again, keeping what was already said and decided. A request also
    // ends with the attempt at its phase (a failed model call, say): the recovery that plays the phase again
    // asks afresh, and must not find the old request still standing.
    const ask = async <T>(kind: Pending['kind'], operationId: string, phaseId: string, board: BoardFixture, phase: AbortSignal): Promise<T> => {
      const given = kind === 'ACT' ? await store.call('humanAction',{ operationId, power: request.seat! }) ?? await run.ordersGiven.get(operationId) : null;
      run.controller.signal.throwIfAborted(); phase.throwIfAborted();
      if (given) return given as T;
      return new Promise<T>((resolve, reject) => {
        const cleanup = () => {
          run.controller.signal.removeEventListener('abort',ended); phase.removeEventListener('abort',ended);
        };
        const ended = () => {
          if (run.pending?.resolve === answer) run.pending = null;
          cleanup();
          reject(new DOMException('Stopped by you.','AbortError'));
        };
        const answer = (value: never) => { cleanup(); resolve(value); };
        if (run.controller.signal.aborted || phase.aborted) { ended(); return; }
        run.pending = { kind, operationId, phaseId, board, resolve: answer };
        if (kind === 'ACT') run.lastOrders = run.pending;
        run.controller.signal.addEventListener('abort',ended,{ once: true });
        phase.addEventListener('abort',ended,{ once: true });
        log(`  … waiting for you (${kind === 'TALK' ? 'messages' : 'orders'}) · ${phaseId.split(':').slice(-3).reverse().join(' ')}`);
      });
    };
    const log = (line: string) => { run.log.push(line); if (run.log.length > LOG_LINES) run.log.splice(0,run.log.length - LOG_LINES); };
    const human: HumanSeat | undefined = request.seat ? { power: request.seat,
      talk: context => ask('TALK',context.operationId,context.phaseId,context.board,context.signal), act: context => ask('ACT',context.operationId,context.phaseId,context.board,context.signal) } : undefined;
    this.running = { runId: request.runId, run };
    this.finished.delete(request.runId);
    log(`Started ${request.live ? 'with live models' : 'with stand-in models (free)'} · ${request.until === 'win' ? 'until a power wins' : `to Fall ${lastYear}`} · ${effort} reasoning effort`);
    this.completion = autoplay({ store, runId: request.runId, lastYear, assignment, transports, transportKind: request.live ? 'live' : 'mock', talkRecipients: messages,
      orderCalls, effort, stalemateYears: request.until === 'win' ? 10 : 0, harness: harnessVersion(), signal: run.controller.signal, log, now: this.now, ...(human ? { human } : {}) })
      .then(result => {
        log(`${result.status}${result.endedBy ? ` · ${result.endedBy}` : ''}${result.waitingOn ? ` · ${result.waitingOn}` : ''}`);
        this.finished.set(request.runId,{ log: run.log, endedAt: this.now(), error: null, result, failures: result.record.failures });
      })
      .catch(error => {
        // Never the raw error of a provider; these are the harness's own messages.
        const message = error instanceof Error ? error.message : 'The game stopped unexpectedly.';
        log(`Could not run: ${message}`);
        this.finished.set(request.runId,{ log: run.log, endedAt: this.now(), error: message, result: null, failures: [] });
      })
      .finally(() => { if (this.running?.run === run) this.running = null; });
    return { runId: request.runId };
  }

  /** The legal orders of the person's units for the orders phase in hand, so they can plan while they write. */
  async legal(runId: string) {
    const pending = this.running?.runId === runId ? this.running.run.pending : null;
    if (!pending?.board) throw new RequestError('This game is not waiting for you.');
    if (pending.board!.phase !== 'ORDERS') return { options: [] };
    const options = await this.rules.legal(pending.board!,this.running!.run.settings.seat!,new AbortController().signal);
    return { options: options.map(o => ({ id: o.id, unitTerritory: o.unitTerritory, order: o.order, description: o.description })) };
  }
  /** The person's messages for this turn: at most one to each other power still in the game. */
  async talk(runId: string, messages: unknown, phaseId?: string): Promise<void> {
    const pending = this.waiting(runId,'TALK',phaseId), run = this.running!.run, seat = run.settings.seat!;
    if (!Array.isArray(messages) || messages.length > 6) throw new RequestError('Send at most one message to each power.');
    const clean = messages.map(m => ({ to: String((m as { to?: unknown })?.to ?? '').toUpperCase() as Power, body: String((m as { body?: unknown })?.body ?? '').replace(/\s+/g,' ').trim() }));
    if (clean.some(m => !ALL_POWERS.includes(m.to) || m.to === seat || !pending.board!.units.some(unit => unit.power === m.to) || !m.body || m.body.length > 500) || new Set(clean.map(m => m.to)).size !== clean.length)
      throw new RequestError('Each message needs another power and 1–500 characters, one per power.');
    const store = await this.open(run.settings.live ? 'live' : 'standIn');
    await store.call('saveHumanTalk',{ attemptId: `auto-${runId}`, operationId: pending.operationId, phaseId: pending.phaseId, power: seat, messages: clean, now: this.now() });
    if (this.running?.run === run && run.pending === pending) { run.pending = null; pending.resolve(clean as never); }
  }
  /** The person's action for this phase, checked against the rules before the game sees it. */
  async act(runId: string, action: PhaseAction, phaseId?: string): Promise<void> {
    const run = this.running?.runId === runId ? this.running.run : null, last = run?.lastOrders;
    // Between attempts at a phase the request is withdrawn for a moment; orders for it still count.
    const between = run && !run.pending && last && phaseId !== undefined && last.phaseId === phaseId && !run.ordersGiven.has(last.operationId);
    const pending = between ? last : this.waiting(runId,'ACT',phaseId), seat = run!.settings.seat!;
    try { await this.rules.validate(pending.board!,seat,action,new AbortController().signal); }
    catch { throw new RequestError('Those orders are not legal for this phase. Check each unit and try again.'); }
    if (this.running?.run !== run || run.controller.signal.aborted)
      throw new RequestError('This game is no longer waiting for these orders.');
    const saving = (async () => {
      const store = await this.open(run.settings.live ? 'live' : 'standIn');
      await store.call('saveHumanAction',{ attemptId: `auto-${runId}`, operationId: pending.operationId, phaseId: pending.phaseId, power: seat, action, now: this.now() });
      return action;
    })();
    const given = saving.catch(() => {
      if (run.ordersGiven.get(pending.operationId) === given) run.ordersGiven.delete(pending.operationId);
      return null;
    });
    run.ordersGiven.set(pending.operationId,given);
    await saving;
    // The phase may have started again while the orders were checked; they answer its new request.
    const current = this.running?.runId === runId ? this.running.run.pending : null;
    if (current && current.kind === 'ACT' && current.phaseId === pending.phaseId && current.operationId === pending.operationId) { this.running!.run.pending = null; current.resolve(action as never); }
  }
  private waiting(runId: string, kind: Pending['kind'], phaseId?: string): Pending {
    const pending = this.running?.runId === runId ? this.running.run.pending : null;
    if (!pending || pending.kind !== kind) throw new RequestError(kind === 'TALK' ? 'This game is not waiting for your messages.' : 'This game is not waiting for your orders.');
    if (phaseId !== undefined && pending.phaseId !== phaseId) throw new RequestError('This phase has changed. Reload the game before submitting.');
    return pending;
  }

  /** Stops the running game after the phase in hand, as Ctrl-C does; it can be continued later. */
  stop(runId: string): boolean {
    if (this.running?.runId !== runId) return false;
    this.running.run.controller.abort();
    return true;
  }

  router(): express.Router {
    const router = express.Router();
    // The harness's own refusals (a missing grant or key, a bad setting) are shown as they are; storage failures are not.
    const fail = (res: Response, error: unknown) => {
      if (error instanceof Error && !(error instanceof StoreError)) res.status(400).json({ code: 'INVALID_REQUEST', message: error.message });
      else res.status(500).json({ code: 'FULL_GAMES_UNAVAILABLE', message: 'The full-games service could not complete the request.' });
    };
    router.get('/',async (_req,res) => { try { res.json(await this.list()); } catch (e) { fail(res,e); } });
    router.get('/:runId',async (req,res) => {
      try { const game = await this.game(req.params.runId); if (!game) res.status(404).json({ code: 'NOT_FOUND' }); else res.json(game); } catch (e) { fail(res,e); }
    });
    router.post('/',async (req,res) => { try { res.json(await this.start(req.body as StartRequest)); } catch (e) { fail(res,e); } });
    router.post('/:runId/stop',(req,res) => { res.json({ stopping: this.stop(req.params.runId) }); });
    router.get('/:runId/legal',async (req,res) => { try { res.json(await this.legal(req.params.runId)); } catch (e) { fail(res,e); } });
    router.post('/:runId/talk',async (req,res) => {
      try {
        if (typeof req.body?.phaseId !== 'string') throw new RequestError('The phase being answered is required. Reload the game before submitting.');
        await this.talk(req.params.runId,req.body?.messages,req.body.phaseId); res.json({ sent: true });
      } catch (e) { fail(res,e); }
    });
    router.post('/:runId/act',async (req,res) => {
      try {
        if (typeof req.body?.phaseId !== 'string') throw new RequestError('The phase being answered is required. Reload the game before submitting.');
        await this.act(req.params.runId,req.body?.action,req.body.phaseId); res.json({ accepted: true });
      } catch (e) { fail(res,e); }
    });
    return router;
  }
}
