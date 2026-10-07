import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { ALL_POWERS, TERRITORIES } from '@diplomacy/shared';
import type { ExhibitionReplay, ExhibitionSummary } from '@diplomacy/shared';
import type { RuntimeConfig } from '../../../config/runtime.cjs';
import { AuthService, type Principal } from '../auth.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { fixtureSchema as schema, FixtureError } from '../fixtures/BoardFixture.js';
import { RateLimiter } from '../limits/RateLimiter.js';
import type { Store } from '../storage/Store.js';
import { StoreError, type StoredExhibition } from '../storage/contracts.js';
import { ExhibitionRunner } from './ExhibitionRunner.js';

/** Unfinished games allowed at once; each is a few short engine runs per tick. */
const MAX_UNFINISHED = 2;
const DEFAULT_PHASES = 40;

/** Bot-only exhibition games: anyone may watch, only the operator may start, pause, resume or cancel one. */
export class ExhibitionService {
  readonly runner: ExhibitionRunner;
  constructor(private store: Store, private config: RuntimeConfig, private now: () => number = Date.now) {
    this.runner = new ExhibitionRunner(store,new PhaseRules(),{ now });
  }
  private async summary(game: StoredExhibition): Promise<ExhibitionSummary> {
    const challenge = await this.store.call('challenge',{ id: game.challengeId, version: game.challengeVersion });
    return { id: game.id, title: challenge?.definition.title ?? game.challengeId, state: game.state, reason: game.reason, phases: game.phases, maxPhases: game.maxPhases,
      year: game.board.year, season: game.board.season, phase: game.board.phase, createdAt: game.createdAt, updatedAt: game.updatedAt,
      centers: Object.fromEntries(ALL_POWERS.map(p => [p,TERRITORIES.filter(t => t.isSupplyCenter && game.board.territoryOwners[t.id] === p).length])) as ExhibitionSummary['centers'] };
  }
  router(auth: AuthService): express.Router {
    const router = express.Router(), limits = new RateLimiter(this.config.trustedProxy,this.now);
    const run = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
      void handler(req,res).catch(error => {
        if (error instanceof FixtureError) { res.status(400).json({ code: 'INVALID_REQUEST', message: 'Invalid exhibition request.' }); return; }
        const code = error instanceof StoreError ? error.code : 'SERVICE_UNAVAILABLE';
        res.status(code === 'STORE_INVALID' ? 400 : code === 'STORE_FORBIDDEN' ? 404 : code === 'STORE_CONFLICT' ? 409 : 503)
          .json({ code, message: error instanceof StoreError ? error.message : 'Exhibition games are temporarily unavailable.' });
      });
    };
    const found = async (id: string) => {
      if (!/^[A-Za-z0-9:_-]{1,100}$/.test(id)) throw new StoreError('STORE_FORBIDDEN','Exhibition not found.');
      return await this.store.call('exhibition',{ id }) ?? (() => { throw new StoreError('STORE_FORBIDDEN','Exhibition not found.'); })();
    };
    // Public: a bot-only game has no private state, so its position and reports can be shown to anyone.
    router.get('/exhibitions',limits.address('public'),run(async (_req,res) => {
      res.json({ exhibitions: await Promise.all((await this.store.call('exhibitions',{ limit: 10 })).map(g => this.summary(g))) });
    }));
    router.get('/exhibitions/:id',limits.address('public'),run(async (req,res) => {
      const game = await found(req.params.id);
      const replay: ExhibitionReplay = { kind: 'EXHIBITION', exhibition: await this.summary(game), reports: await this.store.call('exhibitionReports',{ id: game.id }) };
      res.json(replay);
    }));
    const operator = [limits.address('operator'),auth.requirePlayer(true),limits.identity('operator')];
    router.post('/operator/exhibitions',operator,run(async (req,res) => {
      const body = schema.fields(req.body,['challengeId','challengeVersion',...(req.body && typeof req.body === 'object' && Object.hasOwn(req.body,'maxPhases') ? ['maxPhases'] : [])],'exhibition');
      if (typeof body.challengeId !== 'string' || !Number.isSafeInteger(body.challengeVersion) || (body.maxPhases !== undefined && !Number.isSafeInteger(body.maxPhases))) throw new StoreError('STORE_INVALID','Choose a registered scenario and a phase limit.');
      const game = await this.store.call('createExhibition',{ id: randomUUID(), challengeId: body.challengeId, challengeVersion: body.challengeVersion as number, maxPhases: (body.maxPhases as number | undefined) ?? DEFAULT_PHASES,
        createdBy: (res.locals.principal as Principal).player.id, maxRunning: MAX_UNFINISHED, now: this.now() });
      await this.store.call('recordOperatorAction',{ operatorId: (res.locals.principal as Principal).player.id, action: 'EXHIBITION_START', target: game.id, now: this.now() });
      res.json(await this.summary(game));
    }));
    for (const action of ['pause','resume','cancel'] as const) router.post(`/operator/exhibitions/:id/${action}`,operator,run(async (req,res) => {
      schema.fields(req.body,[],action);
      const game = await found(req.params.id);
      const next = await this.store.call('setExhibitionState',{ id: game.id, action: action.toUpperCase() as 'PAUSE' | 'RESUME' | 'CANCEL', now: this.now() });
      await this.store.call('recordOperatorAction',{ operatorId: (res.locals.principal as Principal).player.id, action: `EXHIBITION_${action.toUpperCase()}` as 'EXHIBITION_PAUSE', target: game.id, now: this.now() });
      res.json(await this.summary(next));
    }));
    return router;
  }
  async close(): Promise<void> { await this.runner.close(); }
}
