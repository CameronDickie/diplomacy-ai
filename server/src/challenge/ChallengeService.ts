import express, { type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RuntimeConfig } from '../../../config/runtime.cjs';
import type { ChallengeCard, ChallengeAttemptView, ChallengeCatalog, ChallengeLibrary, ChallengeMode, ChallengeReplay } from '@diplomacy/shared';
import { featuredSlot, parseRotation, type RotationManifest } from './Catalog.js';
import { AuthService, type Principal } from '../auth.js';
import { Store } from '../storage/Store.js';
import { StoreError, type StoredAttempt } from '../storage/contracts.js';
import { publicBoard, publicReplay } from '../storage/publicData.js';
import { canonicalJson, FixtureError, fixtureSchema as schema } from '../fixtures/BoardFixture.js';
import { importScenario, challengeDefinition, playWitness, type ScenarioFixture } from '../fixtures/ScenarioFixture.js';
import type { ChallengeDefinition } from './TunisPilot.js';
import { AttemptService, offlineDecisions } from '../attempts/AttemptService.js';
import { practiceBot } from '../attempts/PracticeBot.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { RateLimiter, type RateCategory } from '../limits/RateLimiter.js';
import { opponentContract, type OpponentContract } from '../providers/OpponentContract.js';
import { gameRecord, playtestLog } from './PlaytestLog.js';
import { LunaDecisionError } from '../luna/LunaDecisionProvider.js';
import { OpponentChat } from './OpponentChat.js';
import { ALL_POWERS } from '@diplomacy/shared';
import { mixedPlan, type OpponentPlan } from '../providers/OpponentPlan.js';
import { anthropicHaikuTransport } from '../luna/HaikuTransport.js';
import { LunaDecisionProvider } from '../luna/LunaDecisionProvider.js';
import { routedDecisions } from '../luna/Routing.js';
import { httpLunaTransport, mockOpponentTransport, type LunaTransport } from '../luna/Transport.js';

const HISTORY_PAGE=20;
export class ChallengeService {
  readonly attempts: AttemptService;
  private rules = new PhaseRules();
  private rotation!: RotationManifest;
  private catalog: Array<{card:ChallengeCard;fixture:ScenarioFixture}> = [];
  private replays = new Map<string,Promise<ChallengeReplay>>();
  private sweepTimer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  private nextRetention = 0;
  private limits: RateLimiter;
  /** Set when sponsored attempts can be offered by this process: a development mock, or an injected test transport. */
  private readonly sponsoredMock:boolean;
  private readonly sponsoredOffered:boolean;
  /** What new sponsored attempts are pinned to. Existing attempts keep what they started with. */
  private readonly plan:OpponentPlan;
  /** Development playtest against the real providers. Never true outside the local, non-production profile. */
  private readonly sponsoredLive:boolean;
  /** Paid AI available: the preset's real provider plays sponsored attempts, behind the ledger and the Operator switch. */
  private readonly sponsoredPaid:boolean;
  /** Development only: private conversations with opponents. Null everywhere else. */
  private readonly chat:OpponentChat|null;
  /** A local, non-production server: development conveniences are allowed. */
  private readonly development:boolean;
  /** Development only, in memory: why phases had to wait. Lost on restart by design. */
  private readonly failures=new Map<string,Array<{at:number;phaseId:string;reason:string}>>();
  private constructor(private store:Store,private config:RuntimeConfig,private now:()=>number,transport?:LunaTransport,env:NodeJS.ProcessEnv=process.env) {
    const development=this.development=config.profile==='local'&&!config.production;
    // Checked here as well as in the configuration contract: a hand-built config must not reach a provider either.
    // Outside development the only stand-in is the staging check's, on reserved .test origins (stagingStandIn).
    if(!development&&(config.lunaTransport==='live'||Object.keys(config.playtestOpponents).length||(config.lunaTransport==='mock'&&!config.stagingStandIn)))throw Error('Development opponent transports are not available in this profile.');
    this.plan=mixedPlan(config.playtestOpponents,opponentContract(config.sponsoredPreset));
    this.sponsoredMock=!transport&&config.lunaTransport==='mock';
    this.sponsoredLive=!transport&&config.lunaTransport==='live';
    // With paid AI available the real provider plays sponsored attempts. Every call still reserves its worst
    // case in the funding ledger first, and players reach it only while the Operator view's switch is on.
    // Unlike a development playtest it exposes no call log, timings or export to the player.
    this.sponsoredPaid=!transport&&config.llm.paidEnabled&&config.lunaTransport==='none';
    const seed=now()%2_147_483_647;
    // One transport per preset in the plan. Live transports read only their own provider's key.
    const build=(contract:OpponentContract):LunaTransport=>this.sponsoredLive||this.sponsoredPaid
      ?(contract.key==='haiku'?anthropicHaikuTransport(env.ANTHROPIC_API_KEY??''):httpLunaTransport(env.OPENAI_API_KEY??''))
      :mockOpponentTransport(contract,{pick:'seeded',seed});
    const transports=this.sponsoredMock||this.sponsoredLive||this.sponsoredPaid?Object.fromEntries(this.plan.contracts.map(c=>[c.key,build(c)])) as Partial<Record<OpponentContract['key'],LunaTransport>>:{};
    const luna=transport??(this.sponsoredMock||this.sponsoredLive||this.sponsoredPaid?build(this.plan.contracts[0]):undefined);
    this.sponsoredOffered=Boolean(luna);
    // Chat exists only where a development transport does; an injected test transport serves every preset.
    this.chat=development&&config.playtestChat&&luna?new OpponentChat(store,this.plan,contract=>transports[contract.key]??luna,{limit:config.chatMessageLimit,now}):null;
    this.limits=new RateLimiter(config.trustedProxy,now);
    this.attempts=new AttemptService(store,routedDecisions(store,offlineDecisions(this.rules),practiceBot(this.rules),luna?new LunaDecisionProvider(store,this.rules,luna,{now,plan:this.plan,transports}):null),this.rules,
      {maxRunning:config.maxActiveAttempts,idleExpireMs:config.idleExpireMinutes*60_000,now,
        // Development only: say why a phase is waiting, on the console and to the playtester. Nothing is recorded elsewhere.
        ...(development&&(this.sponsoredMock||this.sponsoredLive)?{onPhaseFailure:(job,error)=>{
          const reason=error instanceof LunaDecisionError?`${error.power} could not decide (${error.code})`:error instanceof Error?error.message:'unknown failure';
          const list=this.failures.get(job.attemptId)??[];list.push({at:now(),phaseId:job.phaseId,reason});this.failures.set(job.attemptId,list.slice(-50));
          console.warn(`[playtest] ${job.phaseId} is waiting: ${reason}`);
        }}:{})});
  }
  static async open(store:Store,config:RuntimeConfig,now=Date.now,options:{lunaTransport?:LunaTransport;env?:NodeJS.ProcessEnv}={}):Promise<ChallengeService> {
    const service=new ChallengeService(store,config,now,options.lunaTransport,options.env);
    const load=async(path:string)=>JSON.parse(await readFile(new URL(`../../fixtures/${path}`,import.meta.url),'utf8'));
    service.rotation=parseRotation(await load('rotation/development.v1.json'));
    for(const entry of service.rotation.entries){
      const fixture=await importScenario(await load(`development/${entry.id}.v${entry.version}.json`)),definition=challengeDefinition(fixture);
      if(!definition||fixture.id!==entry.id||fixture.version!==entry.version)throw Error('Rotation entry does not match a scored scenario fixture.');
      const content={definition,board:fixture.board};
      await store.call('registerChallenge',{...content,hash:createHash('sha256').update(canonicalJson(content)).digest('hex'),now:now()});
      service.catalog.push({card:service.card(definition,fixture.board),fixture});
    }
    // Operating limits come from validated configuration; funds come only from explicit grants in the database.
    await store.call('setFundingPolicy',{attemptCapNanousd:Math.min(15_000_000_000,Math.max(1,Math.round(config.llm.maxGameSpendUsd*1e9))),
      ceilingLimitNanousd:config.llm.paidEnabled?Math.round(config.llm.totalBudgetUsd*1e9):null,now:now()});
    if(config.llm.paidEnabled)await store.call('initializePaidSwitch',{now:now()});
    // Today's reference run is packaged before serving; the others are built on first use and cached.
    await service.replay(service.featured().entry);
    await service.sweep();
    await service.attempts.recover();
    service.sweepTimer=setInterval(()=>{void service.sweep().catch(()=>{});},10_000);service.sweepTimer.unref();
    return service;
  }
  private featured() {
    const slot=featuredSlot(this.rotation,this.now());
    return {slot,entry:this.catalog[slot.index]};
  }
  private replay(entry:{card:ChallengeCard;fixture:ScenarioFixture}):Promise<ChallengeReplay> {
    const key=`${entry.card.id}@${entry.card.version}`;
    let packaged=this.replays.get(key);
    if(!packaged){
      packaged=playWitness(entry.fixture,'early-capture',true).then(played=>publicReplay(entry.card,played.reports!));
      this.replays.set(key,packaged);
      // A failed build is not cached, so the next request can try again.
      packaged.catch(()=>{if(this.replays.get(key)===packaged)this.replays.delete(key);});
    }
    return packaged;
  }
  /** Says plainly which model decides which power, and whether real provider calls are made. */
  private sponsoredLabel(definition:ChallengeDefinition):string {
    const models=definition.opponentPowers.map(power=>`${power} ${this.plan.contractFor(power).preset.model}`).join(', ');
    // The single-Luna wording is what players of the public showcase have always been shown.
    const only=this.plan.contracts[0];
    const who=this.plan.mixed?`Mixed opponents (${models})`:only.key==='luna'?'Luna opponents':only.key==='haiku'?'Claude Haiku 5.5 opponents':`${only.preset.model} opponents`;
    if(!this.sponsoredMock&&!this.sponsoredLive&&!this.plan.mixed&&only.key==='luna')return 'GPT-6 Luna opponents · sponsored';
    return this.sponsoredMock?`Mock ${who} · development stand-in, no provider calls`
      :this.sponsoredLive?`Live ${who} · development playtest, real provider calls from your local ledger`:`${who} · sponsored`;
  }
  private card(definition:ChallengeDefinition,board:StoredAttempt['board'],mode:ChallengeMode='PRACTICE'):ChallengeCard {
    return {id:definition.id,version:definition.version,title:definition.title,objectiveText:definition.objectiveText,humanPower:definition.humanPower,targetTerritory:definition.objective.territory,
      deadlineYear:definition.objective.deadlineYear,earlyAchievementYear:definition.earlyAchievementYear,
      label:'DEVELOPMENT_PILOT',mode,opponentLabel:mode==='PRACTICE'?'Offline practice · hold-only opponents':mode==='BOT'?'Practice bot · free scripted opponents, no AI model':this.sponsoredLabel(definition),
      board:{...publicBoard(board),year:board.year,season:board.season,phase:board.phase}};
  }
  private async view(attempt:StoredAttempt):Promise<ChallengeAttemptView> {
    const challenge=(await this.store.call('challenge',{id:attempt.challengeId,version:attempt.challengeVersion}))!;
    const submission=await this.store.call('latestSubmission',{attemptId:attempt.id,playerId:attempt.playerId,phaseId:attempt.phaseId});
    // A waiting sponsored phase tells the player which of three things is true, so the next action is clear.
    let notice:ChallengeAttemptView['notice']=null;
    if(attempt.mode==='SPONSORED'&&attempt.lifecycle==='ACTIVE'&&attempt.execution==='RECOVERING'){
      const [paid,funding,own]=await Promise.all([this.store.call('paidState',{}),this.store.call('fundingTotals',{}),this.store.call('attemptFunding',{attemptId:attempt.id})]);
      notice=paid.stopped?'SPONSORED_PAUSED':own.settledNanousd+own.heldNanousd+this.plan.reservationNanousd>funding.attemptCapNanousd?'ATTEMPT_BUDGET':'SPONSORED_RETRY';
    }
    // Development playtests only: the facts behind a waiting phase, from the call records and the last failure.
    let noticeDetail:string[]|undefined;
    if((this.sponsoredMock||this.sponsoredLive)&&attempt.mode==='SPONSORED'&&attempt.execution==='RECOVERING'){
      const calls=(await this.store.call('providerCallsForAttempt',{attemptId:attempt.id})).filter(c=>c.fence.phaseId===attempt.phaseId&&c.role!=='CHAT'&&c.outcome!=='VALID');
      noticeDetail=[...(this.failures.get(attempt.id)??[]).filter(f=>f.phaseId===attempt.phaseId).slice(-1).map(f=>f.reason),
        ...calls.map(c=>`${c.power} · ${c.model}: ${c.outcome??`${c.state.toLowerCase()}, no answer recorded`}${c.dispatchedAt!==null&&(c.finishedAt??c.receivedAt)!==null?` after ${(((c.finishedAt??c.receivedAt)!-c.dispatchedAt)/1000).toFixed(1)} s`:''}`)];
    }
    return {id:attempt.id,revision:attempt.revision,phaseId:attempt.phaseId,challenge:this.card(challenge.definition,challenge.board,attempt.mode),mode:attempt.mode,notice,...(noticeDetail?.length?{noticeDetail}:{}),
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
      await this.retain();
    })().finally(()=>{this.sweeping=undefined;});
    return this.sweeping;
  }
  /** Hourly, in bounded batches. A failed pass waits for the next hour, never a tight retry loop. */
  private async retain():Promise<void> {
    const now=this.now(),day=86_400_000,resultBefore=now-this.config.resultRetentionDays*day;
    if(now<this.nextRetention)return;
    this.nextRetention=now+3_600_000;
    // Cleanup is housekeeping: a busy or failed pass must not fail the player request that triggered it.
    try{for(let batch=0;batch<20;batch++){
      const result=await this.store.call('sweepRetention',{now,resultBefore,diagnosticBefore:Math.max(resultBefore,now-this.config.diagnosticRetentionDays*day),
        receiptBefore:now-this.config.receiptRetentionDays*day,limit:200});
      if(!result.more)break;
    }
    // Frees reservations of calls that were prepared but can no longer be dispatched.
    await this.store.call('reconcileFunding',{now});}catch{}
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
    // Ordinary players get the day's challenge. The operator, and anyone on a local development server, may pick any of them.
    const mayChoose=(res:Response)=>(res.locals.principal as Principal).operator||this.development;
    // Address bucket first so unauthenticated floods are bounded, then the account bucket.
    const guarded=(category:Exclude<RateCategory,'public'>)=>[this.limits.address(category),auth.requirePlayer(),this.limits.identity(category)];
    const run=(handler:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response)=>{
      void handler(req,res).catch(error=>{
        if(error instanceof FixtureError){res.status(400).json({code:'INVALID_REQUEST',message:'Choose valid challenge fields and current legal actions.'});return;}
        const code=error instanceof StoreError?error.code:'SERVICE_UNAVAILABLE';
        const status=code==='STORE_FORBIDDEN'?404:code==='STORE_INVALID'?400:['CAPACITY_FULL','ACTIVE_ATTEMPT_EXISTS','DAILY_LIMIT','STORE_CONFLICT','BUDGET_EXHAUSTED','ATTEMPT_BUDGET_EXHAUSTED','SPONSORED_UNAVAILABLE','CHAT_LIMIT'].includes(code)?409:503;
        res.status(status).json({code,message:error instanceof StoreError?error.message:'Challenge play is temporarily unavailable. Retry shortly.'});
      });
    };
    // Public GETs make no session or provider call; the catalog adds two counters so availability is honest.
    router.get('/challenges',this.limits.address('public'),run(async(_req,res)=>{
      const [active,paid]=await Promise.all([this.store.call('activeAttempts',{}),this.store.call('paidState',{})]);
      const {slot,entry}=this.featured();
      const catalog:ChallengeCatalog={challenges:[entry.card],rotation:{id:this.rotation.id,version:this.rotation.version,label:'DEVELOPMENT_ROTATION',day:slot.day,index:slot.index,size:this.catalog.length,nextChangeAt:slot.nextChangeAt},sponsoredPlay:!this.sponsoredOffered?'NOT_OFFERED':paid.stopped?'PAUSED':'OPEN',sponsoredMock:this.sponsoredMock,...(this.sponsoredOffered?{sponsoredModel:this.plan.contracts[0].key==='haiku'?'Claude Haiku 5.5':'GPT-6 Luna'}:{}),...(this.sponsoredLive?{sponsoredLive:true}:{}),...(this.chat?{sponsoredChat:true}:{}),
        capacity:active.length>=this.config.maxActiveAttempts?'FULL':'OPEN',limits:{maxActiveAttempts:this.config.maxActiveAttempts,maxActivePerAccount:this.config.maxActivePerAccount,
        dailyStartLimit:this.config.dailyStartLimit,idleWarnMinutes:this.config.idleWarnMinutes,idleExpireMinutes:this.config.idleExpireMinutes,resultRetentionDays:this.config.resultRetentionDays}};
      res.json(catalog);
    }));
    // One owner notice per account per pause; the store refuses unless sponsored play is actually stopped.
    router.post('/credit-request',guarded('account'),run(async(req,res)=>{
      schema.fields(req.body,[],'credit request');
      if(!this.sponsoredOffered)throw new StoreError('STORE_CONFLICT','Sponsored play is not offered yet, so there is nothing to request.');
      res.json(await this.store.call('requestCredit',{playerId:player(res),now:this.now()}));
    }));
    // Every challenge in the rotation, for those allowed to choose one. Players are refused, not shown an empty list.
    router.get('/challenges/library',guarded('read'),run(async(_req,res)=>{
      if(!mayChoose(res)){res.status(403).json({code:'OPERATOR_REQUIRED',message:'Only the operator can choose a challenge.'});return;}
      const library:ChallengeLibrary={featuredId:this.featured().entry.card.id,challenges:this.catalog.map(e=>e.card)};
      res.json(library);
    }));
    router.get('/challenges/demo',this.limits.address('public'),run(async(_req,res)=>{res.json(await this.replay(this.featured().entry));}));
    router.get('/attempts',guarded('read'),run(async(req,res)=>{
      const cursor=typeof req.query.before==='string'?/^(\d{1,16})\.([-A-Za-z0-9_]{1,100})$/.exec(req.query.before):null;
      if(req.query.before!==undefined&&!cursor)throw new StoreError('STORE_INVALID','Reload your attempt history.');
      await this.sweep();
      const items=await this.store.call('ownedAttempts',{playerId:player(res),limit:HISTORY_PAGE+1,...(cursor?{before:{createdAt:Number(cursor[1]),id:cursor[2]}}:{})});
      const page=items.slice(0,HISTORY_PAGE),last=page.at(-1);
      res.json({attempts:await Promise.all(page.map(a=>this.view(a))),next:items.length>HISTORY_PAGE&&last?`${last.createdAt}.${last.id}`:null});
    }));
    router.post('/account/delete',guarded('account'),run(async(req,res)=>{
      const body=schema.fields(req.body,['confirm'],'account deletion');
      if(body.confirm!=='DELETE')throw new StoreError('STORE_INVALID','Confirm account deletion to continue.');
      auth.forget(await this.attempts.deleteAccount(player(res)),res);
      res.json({deleted:true});
    }));
    router.post('/attempts',guarded('start'),run(async(req,res)=>{
      // `mode` is the one optional field. Model, preset, budget, board or persona are never accepted from a client.
      const body=schema.fields(req.body,['requestId','challengeId','challengeVersion',...(req.body&&typeof req.body==='object'&&Object.hasOwn(req.body,'mode')?['mode']:[])],'start');
      const mode=body.mode===undefined?'PRACTICE':body.mode;
      if(mode!=='PRACTICE'&&mode!=='BOT'&&mode!=='SPONSORED')throw new StoreError('STORE_INVALID','Choose practice, the practice bot or sponsored play.');
      if(mode==='SPONSORED'&&!this.sponsoredOffered)throw new StoreError('SPONSORED_UNAVAILABLE','Sponsored play is not offered yet. Practice and the replay are available.');
      if(typeof body.requestId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(body.requestId))throw new StoreError('STORE_INVALID','A valid start request ID is required.');
      // A page left open across midnight UTC still holds yesterday's card: its accepted start can be replayed, nothing new begins.
      const featured=this.featured().entry.card,selected=this.catalog.find(e=>e.card.id===body.challengeId&&e.card.version===body.challengeVersion)?.card;
      if(!selected)throw new StoreError('STORE_INVALID','Choose a challenge from the current catalog.');
      await this.sweep();
      const attempt=await this.store.call('admitAttempt',{id:randomUUID(),playerId:player(res),requestId:body.requestId,challengeId:selected.id,challengeVersion:selected.version,
        now:this.now(),maxActive:this.config.maxActiveAttempts,maxPerAccount:this.config.maxActivePerAccount,dailyLimit:this.config.dailyStartLimit,replayOnly:selected!==featured&&!mayChoose(res),
        // The preset and its price list are pinned to the attempt; the pool must cover at least one worst-case call.
        ...(mode==='BOT'?{bot:true}:{}),
        ...(mode==='SPONSORED'?{sponsored:{preset:{id:this.plan.id,pricingVersion:this.plan.pricingVersion},minimumAvailableNanousd:this.plan.reservationNanousd}}:{})});
      res.json(await this.view(attempt));
    }));
    router.get('/attempts/:id',guarded('read'),run(async(req,res)=>{res.json(await this.view(await this.owned(req.params.id,player(res))));}));
    router.get('/attempts/:id/legal',guarded('legal'),run(async(req,res)=>{
      const attempt=await this.owned(req.params.id,player(res));
      if(attempt.lifecycle!=='ACTIVE'||attempt.execution!=='ACCEPTING'||attempt.board.phase!=='ORDERS')throw new StoreError('STORE_CONFLICT','Legal movement choices are unavailable for this phase.');
      const challenge=(await this.store.call('challenge',{id:attempt.challengeId,version:attempt.challengeVersion}))!;
      const options=await this.rules.legal(attempt.board,challenge.definition.humanPower,AbortSignal.timeout(this.config.engine.timeoutMs));
      const latest=await this.owned(attempt.id,player(res));
      if(latest.revision!==attempt.revision||latest.lifecycle!=='ACTIVE')throw new StoreError('STORE_CONFLICT','Phase changed while loading legal choices. Reload.');
      res.json({attemptId:attempt.id,phaseId:attempt.phaseId,revision:attempt.revision,options});
    }));
    router.post('/attempts/:id/orders',guarded('command'),run(async(req,res)=>{
      const body=schema.fields(req.body,['revision','phaseId','requestId','action'],'submission');
      if(!Number.isSafeInteger(body.revision)||typeof body.phaseId!=='string'||typeof body.requestId!=='string')throw new StoreError('STORE_INVALID','A current phase and request ID are required.');
      await this.owned(req.params.id,player(res));
      const receipt=await this.attempts.submit({attemptId:req.params.id,playerId:player(res),revision:body.revision as number,phaseId:body.phaseId,requestId:body.requestId,action:body.action});
      res.json(receipt.state);
    }));
    router.post('/attempts/:id/activity',guarded('command'),run(async(req,res)=>{
      const body=schema.fields(req.body,['revision'],'activity');
      if(!Number.isSafeInteger(body.revision))throw new StoreError('STORE_INVALID','A current revision is required.');
      await this.owned(req.params.id,player(res));
      res.json(await this.view(await this.store.call('touchAttempt',{id:req.params.id,playerId:player(res),expectedRevision:body.revision as number,idleBefore:this.now()-this.config.idleExpireMinutes*60_000,now:this.now()})));
    }));
    router.post('/attempts/:id/abandon',guarded('command'),run(async(req,res)=>{
      schema.fields(req.body,[],'abandon');await this.owned(req.params.id,player(res));
      res.json(await this.view(await this.attempts.terminate(req.params.id,player(res),'ABANDONED')));
    }));
    router.post('/attempts/:id/recover',guarded('command'),run(async(req,res)=>{
      schema.fields(req.body,[],'recover');const owned=await this.owned(req.params.id,player(res));
      if(owned.lifecycle!=='ACTIVE'||owned.execution!=='RECOVERING')throw new StoreError('STORE_CONFLICT','This attempt does not need recovery.');
      await this.attempts.recover(owned.id);res.json(await this.view(await this.owned(req.params.id,player(res))));
    }));
    router.get('/attempts/:id/reports',guarded('read'),run(async(req,res)=>{
      await this.owned(req.params.id,player(res));res.json({reports:await this.store.call('reports',{attemptId:req.params.id})});
    }));
    // Development only: the player's private conversations with opponents. Not registered anywhere else.
    const chat=this.chat;
    if(chat){
      router.get('/attempts/:id/chat',guarded('read'),run(async(req,res)=>{res.json(await chat.view(await this.owned(req.params.id,player(res))));}));
      router.post('/attempts/:id/chat',guarded('command'),run(async(req,res)=>{
        const body=schema.fields(req.body,['power','requestId','body'],'message');
        if(typeof body.requestId!=='string'||typeof body.body!=='string'||!ALL_POWERS.includes(body.power as never))throw new StoreError('STORE_INVALID','A power, a request ID and a message are required.');
        const attempt=await this.owned(req.params.id,player(res)),challenge=await this.store.call('challenge',{id:attempt.challengeId,version:attempt.challengeVersion});
        await chat.send(attempt,challenge!,{power:body.power as never,requestId:body.requestId,body:body.body});
        res.json(await chat.view(await this.owned(req.params.id,player(res))));
      }));
    }
    // Development playtests only: which model decided each power, how long it took and what it cost.
    // Not registered at all outside the local, non-production profile.
    if(this.sponsoredMock||this.sponsoredLive)router.get('/attempts/:id/playtest',guarded('read'),run(async(req,res)=>{
      const attempt=await this.owned(req.params.id,player(res));
      res.json(await playtestLog(this.store,attempt.id));
    }));
    // Development playtests only: the whole recorded game in one document, for review after the fact.
    if(this.sponsoredMock||this.sponsoredLive)router.get('/attempts/:id/export',guarded('read'),run(async(req,res)=>{
      const attempt=await this.owned(req.params.id,player(res)),challenge=(await this.store.call('challenge',{id:attempt.challengeId,version:attempt.challengeVersion}))!;
      res.json(await gameRecord(this.store,attempt,challenge,Object.fromEntries(challenge.definition.opponentPowers.map(p=>[p,this.plan.contractFor(p).preset.model])),this.failures.get(attempt.id)??[],this.now()));
    }));
    return router;
  }
  async close():Promise<void>{clearInterval(this.sweepTimer);await this.sweeping?.catch(()=>{});await this.attempts.close();}
}
