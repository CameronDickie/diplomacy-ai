import express, { type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RuntimeConfig } from '../../../config/runtime.cjs';
import type { ChallengeCard, ChallengeAttemptView, ChallengeCatalog, ChallengeReplay } from '@diplomacy/shared';
import { AuthService, type Principal } from '../auth.js';
import { Store } from '../storage/Store.js';
import { StoreError, type StoredAttempt } from '../storage/contracts.js';
import { publicBoard, publicReplay } from '../storage/publicData.js';
import { canonicalJson, FixtureError, fixtureSchema as schema } from '../fixtures/BoardFixture.js';
import { importScenario, challengeDefinition, playWitness } from '../fixtures/ScenarioFixture.js';
import type { ChallengeDefinition } from './TunisPilot.js';
import { AttemptService, offlineDecisions } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';

export class ChallengeService {
  readonly attempts: AttemptService;
  private rules = new PhaseRules();
  private cards: ChallengeCard[] = [];
  private demo: ChallengeReplay | undefined;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  private constructor(private store:Store,private config:RuntimeConfig,private now:()=>number) {
    // Paid startup remains interlocked; this mode must never silently become sponsored.
    if(config.llm.paidEnabled)throw Error('Funded challenge adapter is not integrated.');
    this.attempts=new AttemptService(store,offlineDecisions(this.rules),this.rules,{maxRunning:config.maxActiveAttempts,idleExpireMs:config.idleExpireMinutes*60_000,now});
  }
  static async open(store:Store,config:RuntimeConfig,now=Date.now):Promise<ChallengeService> {
    const service=new ChallengeService(store,config,now);
    const fixture=await importScenario(JSON.parse(await readFile(new URL('../../fixtures/development/tunis-expedition.v1.json',import.meta.url),'utf8')));
    const definition=challengeDefinition(fixture)!;
    const content={definition,board:fixture.board};
    await store.call('registerChallenge',{...content,hash:createHash('sha256').update(canonicalJson(content)).digest('hex'),now:now()});
    const card=service.card(definition,fixture.board);service.cards=[card];
    const played=await playWitness(fixture,'early-capture',true);service.demo=publicReplay(card,played.reports!);
    await service.sweep();
    await service.attempts.recover();
    service.sweepTimer=setInterval(()=>{void service.sweep().catch(()=>{});},10_000);service.sweepTimer.unref();
    return service;
  }
  private card(definition:ChallengeDefinition,board:StoredAttempt['board']):ChallengeCard {
    return {id:definition.id,version:definition.version,title:definition.title,objectiveText:definition.objectiveText,humanPower:definition.humanPower,
      deadlineYear:definition.objective.deadlineYear,earlyAchievementYear:definition.earlyAchievementYear,
      label:'DEVELOPMENT_PILOT',mode:'PRACTICE',opponentLabel:'Offline practice · hold-only opponents',
      board:{...publicBoard(board),year:board.year,season:board.season,phase:board.phase}};
  }
  private async view(attempt:StoredAttempt):Promise<ChallengeAttemptView> {
    const challenge=(await this.store.call('challenge',{id:attempt.challengeId,version:attempt.challengeVersion}))!;
    const submission=await this.store.call('latestSubmission',{attemptId:attempt.id,playerId:attempt.playerId,phaseId:attempt.phaseId});
    return {id:attempt.id,revision:attempt.revision,phaseId:attempt.phaseId,challenge:this.card(challenge.definition,challenge.board),mode:attempt.mode,
      lifecycle:attempt.lifecycle,execution:attempt.execution,board:{...publicBoard(attempt.board),year:attempt.board.year,season:attempt.board.season,phase:attempt.board.phase},
      score:attempt.score,receipt:submission?.receipt.state??null,acceptedAction:submission?.action??null,lastActivityAt:attempt.lastActivityAt,
      idleWarnAt:attempt.lastActivityAt+this.config.idleWarnMinutes*60_000,expiresAt:attempt.lastActivityAt+this.config.idleExpireMinutes*60_000};
  }
  async sweep():Promise<void> {
    if(this.sweeping)return this.sweeping;
    this.sweeping=(async()=>{
      const cutoff=this.now()-this.config.idleExpireMinutes*60_000;
      for(const attempt of await this.store.call('activeAttempts',{}))if(attempt.lastActivityAt<=cutoff)
        await this.attempts.terminate(attempt.id,attempt.playerId,'EXPIRED',cutoff);
    })().finally(()=>{this.sweeping=undefined;});
    return this.sweeping;
  }
  private async owned(id:string,playerId:string):Promise<StoredAttempt> {
    await this.sweep();
    const attempt=await this.store.call('attempt',{id,playerId});
    if(!attempt)throw new StoreError('STORE_FORBIDDEN','Attempt is unavailable to this player.');
    return attempt;
  }
  router(auth:AuthService):express.Router {
    const router=express.Router();
    const player=(res:Response)=>(res.locals.principal as Principal).player.id;
    const run=(handler:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response)=>{
      void handler(req,res).catch(error=>{
        if(error instanceof FixtureError){res.status(400).json({code:'INVALID_REQUEST',message:'Choose valid challenge fields and current legal actions.'});return;}
        const code=error instanceof StoreError?error.code:'SERVICE_UNAVAILABLE';
        const status=code==='STORE_FORBIDDEN'?404:code==='STORE_INVALID'?400:['CAPACITY_FULL','ACTIVE_ATTEMPT_EXISTS','DAILY_LIMIT','STORE_CONFLICT'].includes(code)?409:503;
        res.status(status).json({code,message:error instanceof StoreError?error.message:'Challenge play is temporarily unavailable. Retry shortly.'});
      });
    };
    // Public GETs read only startup-packaged content: no store, session or provider work.
    const catalog:ChallengeCatalog={challenges:this.cards,sponsoredPlay:'UNAVAILABLE',limits:{maxActiveAttempts:this.config.maxActiveAttempts,maxActivePerAccount:this.config.maxActivePerAccount,
      dailyStartLimit:this.config.dailyStartLimit,idleWarnMinutes:this.config.idleWarnMinutes,idleExpireMinutes:this.config.idleExpireMinutes}};
    router.get('/challenges',run(async(_req,res)=>{res.json(catalog);}));
    router.get('/challenges/demo',run(async(_req,res)=>{res.json(this.demo);}));
    router.get('/attempts',auth.requirePlayer(),run(async(_req,res)=>{
      await this.sweep();const items=await this.store.call('ownedAttempts',{playerId:player(res)});
      res.json({attempts:await Promise.all(items.map(a=>this.view(a)))});
    }));
    router.post('/attempts',auth.requirePlayer(),run(async(req,res)=>{
      const body=schema.fields(req.body,['requestId','challengeId','challengeVersion'],'start');
      if(typeof body.requestId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(body.requestId))throw new StoreError('STORE_INVALID','A valid start request ID is required.');
      const selected=this.cards.find(c=>c.id===body.challengeId && c.version===body.challengeVersion);
      if(!selected)throw new StoreError('STORE_INVALID','Choose a challenge from the current catalog.');
      await this.sweep();
      const attempt=await this.store.call('admitAttempt',{id:randomUUID(),playerId:player(res),requestId:body.requestId,challengeId:selected.id,challengeVersion:selected.version,
        now:this.now(),maxActive:this.config.maxActiveAttempts,maxPerAccount:this.config.maxActivePerAccount,dailyLimit:this.config.dailyStartLimit});
      res.json(await this.view(attempt));
    }));
    router.get('/attempts/:id',auth.requirePlayer(),run(async(req,res)=>{res.json(await this.view(await this.owned(req.params.id,player(res))));}));
    router.get('/attempts/:id/legal',auth.requirePlayer(),run(async(req,res)=>{
      const attempt=await this.owned(req.params.id,player(res));
      if(attempt.lifecycle!=='ACTIVE'||attempt.execution!=='ACCEPTING'||attempt.board.phase!=='ORDERS')throw new StoreError('STORE_CONFLICT','Legal movement choices are unavailable for this phase.');
      const challenge=(await this.store.call('challenge',{id:attempt.challengeId,version:attempt.challengeVersion}))!;
      const options=await this.rules.legal(attempt.board,challenge.definition.humanPower,AbortSignal.timeout(this.config.engine.timeoutMs));
      const latest=await this.owned(attempt.id,player(res));
      if(latest.revision!==attempt.revision||latest.lifecycle!=='ACTIVE')throw new StoreError('STORE_CONFLICT','Phase changed while loading legal choices. Reload.');
      res.json({attemptId:attempt.id,phaseId:attempt.phaseId,revision:attempt.revision,options});
    }));
    router.post('/attempts/:id/orders',auth.requirePlayer(),run(async(req,res)=>{
      const body=schema.fields(req.body,['revision','phaseId','requestId','action'],'submission');
      if(!Number.isSafeInteger(body.revision)||typeof body.phaseId!=='string'||typeof body.requestId!=='string')throw new StoreError('STORE_INVALID','A current phase and request ID are required.');
      await this.owned(req.params.id,player(res));
      const receipt=await this.attempts.submit({attemptId:req.params.id,playerId:player(res),revision:body.revision as number,phaseId:body.phaseId,requestId:body.requestId,action:body.action});
      res.json(receipt.state);
    }));
    router.post('/attempts/:id/activity',auth.requirePlayer(),run(async(req,res)=>{
      const body=schema.fields(req.body,['revision'],'activity');
      if(!Number.isSafeInteger(body.revision))throw new StoreError('STORE_INVALID','A current revision is required.');
      await this.owned(req.params.id,player(res));
      res.json(await this.view(await this.store.call('touchAttempt',{id:req.params.id,playerId:player(res),expectedRevision:body.revision as number,idleBefore:this.now()-this.config.idleExpireMinutes*60_000,now:this.now()})));
    }));
    router.post('/attempts/:id/abandon',auth.requirePlayer(),run(async(req,res)=>{
      schema.fields(req.body,[],'abandon');await this.owned(req.params.id,player(res));
      res.json(await this.view(await this.attempts.terminate(req.params.id,player(res),'ABANDONED')));
    }));
    router.post('/attempts/:id/recover',auth.requirePlayer(),run(async(req,res)=>{
      schema.fields(req.body,[],'recover');const owned=await this.owned(req.params.id,player(res));
      if(owned.lifecycle!=='ACTIVE'||owned.execution!=='RECOVERING')throw new StoreError('STORE_CONFLICT','This attempt does not need recovery.');
      await this.attempts.recover(owned.id);res.json(await this.view(await this.owned(req.params.id,player(res))));
    }));
    router.get('/attempts/:id/reports',auth.requirePlayer(),run(async(req,res)=>{
      await this.owned(req.params.id,player(res));res.json({reports:await this.store.call('reports',{attemptId:req.params.id})});
    }));
    return router;
  }
  async close():Promise<void>{clearInterval(this.sweepTimer);await this.sweeping?.catch(()=>{});await this.attempts.close();}
}
