import express, { type Request, type Response } from 'express';
import type { RuntimeConfig } from '../../../config/runtime.cjs';
import type { OperatorAttemptDetail, OperatorOverview } from '@diplomacy/shared';
import { AuthService, type Principal } from '../auth.js';
import type { AttemptService } from '../attempts/AttemptService.js';
import type { Store } from '../storage/Store.js';
import { StoreError } from '../storage/contracts.js';
import { publicBoard } from '../storage/publicData.js';
import { fixtureSchema as schema, FixtureError } from '../fixtures/BoardFixture.js';
import { localDelivery, Notifier, resendDelivery, type Delivery } from './Notifier.js';

const validId = (value: string): string => { if (!/^[A-Za-z0-9:_-]{1,100}$/.test(value)) throw new StoreError('STORE_INVALID','Unknown identifier.'); return value; };

/**
 * Owner-only controls. Every route re-resolves the session and the allowlist from storage, so a
 * revoked session or removed operator loses access on its next request.
 */
export class OperatorService {
  readonly notifier: Notifier;
  constructor(private store: Store, private config: RuntimeConfig, private attempts: AttemptService, private now: () => number = Date.now,
      delivery: Delivery = config.notifyMode === 'resend'
        ? resendDelivery({apiKey:process.env.RESEND_API_KEY ?? '',from:process.env.DIPLOMACY_NOTIFY_FROM ?? '',to:process.env.DIPLOMACY_NOTIFY_TO ?? ''}) : localDelivery) {
    this.notifier = new Notifier(store,delivery,now);
  }
  router(auth: AuthService): express.Router {
    const router = express.Router();
    router.use(auth.requirePlayer(true));
    const operator = (res: Response) => (res.locals.principal as Principal).player.id;
    const run = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
      void handler(req,res).catch(error => {
        if (error instanceof FixtureError) { res.status(400).json({code:'INVALID_REQUEST',message:'Invalid operator request.'}); return; }
        const code = error instanceof StoreError ? error.code : 'SERVICE_UNAVAILABLE';
        res.status(code === 'STORE_INVALID' ? 400 : code === 'STORE_FORBIDDEN' ? 404 : code === 'STORE_CONFLICT' ? 409 : 503)
          .json({code,message:error instanceof StoreError ? error.message : 'Operator controls are temporarily unavailable.'});
      });
    };
    router.get('/overview',run(async (_req,res) => {
      const overview: OperatorOverview = { ...await this.store.call('operatorOverview',{}), maxActiveAttempts:this.config.maxActiveAttempts,
        paidConfigured:this.config.llm.paidEnabled, notifyMode:this.config.notifyMode, reservedNanousd:null };
      res.json(overview);
    }));
    router.get('/attempts/:id',run(async (req,res) => {
      const found = await this.store.call('operatorAttempt',{id:validId(req.params.id)});
      if (!found) throw new StoreError('STORE_FORBIDDEN','Attempt not found.');
      await this.store.call('recordOperatorAction',{operatorId:operator(res),action:'SPECTATE',target:found.attempt.id,now:this.now()});
      const detail: OperatorAttemptDetail = { attempt:found.attempt, score:found.score, reports:found.reports, spend:found.spend,
        board:{...publicBoard(found.board),year:found.board.year,season:found.board.season,phase:found.board.phase} };
      res.json(detail);
    }));
    router.post('/paid',run(async (req,res) => {
      const body = schema.fields(req.body,['stopped'],'paid switch');
      if (typeof body.stopped !== 'boolean') throw new StoreError('STORE_INVALID','Choose stop or resume.');
      res.json(await this.store.call('setPaidStopped',{stopped:body.stopped,operatorId:operator(res),now:this.now()}));
    }));
    router.post('/attempts/:id/stop',run(async (req,res) => {
      schema.fields(req.body,[],'stop');
      const found = await this.store.call('attempt',{id:validId(req.params.id)});
      if (!found) throw new StoreError('STORE_FORBIDDEN','Attempt not found.');
      const stopped = await this.attempts.terminate(found.id,found.playerId,'STOPPED');
      await this.store.call('recordOperatorAction',{operatorId:operator(res),action:'ATTEMPT_STOP',target:found.id,now:this.now()});
      res.json({id:stopped.id,lifecycle:stopped.lifecycle});
    }));
    router.post('/players/:id/ban',run(async (req,res) => {
      const body = schema.fields(req.body,['banned'],'ban'), playerId = validId(req.params.id);
      if (typeof body.banned !== 'boolean') throw new StoreError('STORE_INVALID','Choose ban or unban.');
      if (playerId === operator(res)) throw new StoreError('STORE_INVALID','An operator cannot ban their own account.');
      auth.forget(await this.attempts.banPlayer(playerId,body.banned));
      await this.store.call('recordOperatorAction',{operatorId:operator(res),action:body.banned ? 'PLAYER_BAN' : 'PLAYER_UNBAN',target:playerId,now:this.now()});
      res.json({playerId,banned:body.banned});
    }));
    return router;
  }
  async close(): Promise<void> { await this.notifier.close(); }
}
