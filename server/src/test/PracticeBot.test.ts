import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { ALL_POWERS } from '@diplomacy/shared';
import type { ChallengeAttemptView,ChallengeLegalCatalog,PublicPhaseReport } from '@diplomacy/shared';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { Store,hashToken,newToken } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { canonicalJson } from '../fixtures/BoardFixture.js';
import { challengeDefinition,importScenario } from '../fixtures/ScenarioFixture.js';
import { AttemptService } from '../attempts/AttemptService.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { practiceBot } from '../attempts/PracticeBot.js';
import { buildChoices,retreatChoices } from '../luna/Choices.js';
import type { PhaseJob } from '../attempts/types.js';

const signal=()=>new AbortController().signal;
/** Plays a whole attempt with the human holding (or taking the first choice), returning every committed report. */
async function play(t:test.TestContext,attemptId:string,scenario='tunis-expedition'){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-bot-')),store=await Store.open(join(dir,'game.sqlite')),now=1_800_000_000_000;
  t.after(async()=>{await store.close();await rm(dir,{recursive:true,force:true});});
  const fixture=await importScenario(JSON.parse(await readFile(new URL(`../../fixtures/development/${scenario}.v1.json`,import.meta.url),'utf8'))),definition=challengeDefinition(fixture)!;
  const content={definition,board:fixture.board};
  await store.call('registerChallenge',{...content,hash:createHash('sha256').update(canonicalJson(content)).digest('hex'),now});
  const player=await store.call('identity',{provider:'github',subject:'bot-test',displayName:'Test',now});
  let attempt=await store.call('createAttempt',{id:attemptId,playerId:player.id,challengeId:definition.id,challengeVersion:1,reconnectTokenHash:hashToken('t'),now,bot:true});
  assert.equal(attempt.mode,'BOT');
  const rules=new PhaseRules(),service=new AttemptService(store,practiceBot(rules),rules,{now:()=>now});
  t.after(()=>service.close());
  for(let guard=0;attempt.lifecycle==='ACTIVE'&&guard<60;guard++){
    const board=attempt.board,human=definition.humanPower;
    const action=board.phase==='ORDERS'?{phase:'ORDERS' as const,orderIds:(await rules.legal(board,human,signal())).filter(o=>o.order.type==='HOLD').map(o=>o.id)}
      :board.phase==='RETREATS'?(retreatChoices(board,human)?.toAction(retreatChoices(board,human)!.groups.map(g=>g.choices[0]))??{phase:'RETREATS' as const,retreats:{}})
      :(()=>{const set=buildChoices(board,human);const need=set&&/exactly (\d+)/.exec(set.rule);return set?set.toAction(need?set.choices.slice(0,Number(need[1])).map((_,i)=>i):[]):{phase:'BUILDS' as const,builds:[],disbands:[]};})();
    await service.submit({attemptId,playerId:player.id,revision:attempt.revision,phaseId:attempt.phaseId,requestId:`r-${attempt.revision}`,action});
    await service.wait(attemptId);
    const next=(await store.call('attempt',{id:attemptId}))!;
    // Never left waiting: the bot always produces a complete legal set of decisions.
    assert.notEqual(next.execution,'RECOVERING',`${scenario} stalled at ${board.year} ${board.season} ${board.phase}`);
    attempt=next;
  }
  return {attempt,reports:await store.call('reports',{attemptId}),store,definition};
}
const movesBy=(reports:PublicPhaseReport[],test:(o:{power:string;type:string;resolution:string})=>boolean)=>reports.flatMap(r=>r.phase==='ORDERS'?r.resolvedOrders:[]).filter(test).length;

test('the practice bot plays a whole attempt through builds to a scored end, expands, supports, and makes no provider call',async t=>{
  const {attempt,reports,store,definition}=await play(t,'bot-game-a');
  assert.equal(attempt.lifecycle,'COMPLETED');assert.ok(['SUCCESS','FAILURE'].includes(attempt.score!.outcome));
  // Three game years: orders phases plus winter adjustments once centers change hands.
  assert.ok(reports.length>=7,String(reports.length));assert.ok(reports.some(r=>r.phase==='BUILDS'));
  assert.equal(reports.at(-1)!.year,definition.objective.deadlineYear);
  const opponent=(o:{power:string})=>o.power!==definition.humanPower;
  assert.ok(movesBy(reports,o=>opponent(o)&&o.type==='MOVE')>30);
  assert.ok(movesBy(reports,o=>opponent(o)&&o.type==='MOVE'&&o.resolution==='SUCCEEDS')>15);
  assert.ok(movesBy(reports,o=>opponent(o)&&o.type.startsWith('SUPPORT'))>0);
  // The opponents actually gained supply centers; the holding human did not.
  const owners=reports.at(-1)!.after.territoryOwners,count=(p:string)=>Object.values(owners).filter(o=>o===p).length;
  const start=reports[0].before.territoryOwners,grown=ALL_POWERS.filter(p=>p!==definition.humanPower&&count(p)>Object.values(start).filter(o=>o===p).length);
  assert.ok(grown.length>=3,grown.join());
  assert.ok(reports.filter(r=>r.phase==='BUILDS').some(r=>r.phase==='BUILDS'&&r.adjustments.some(a=>a.builds.length>0)));
  assert.equal((await store.call('providerCallsForAttempt',{attemptId:'bot-game-a'})).length,0);
  assert.equal((await store.call('fundingTotals',{})).settledNanousd,0);
});

test('the same attempt replays identically, a different attempt plays differently, and a recovery repeats its decision',async t=>{
  // Compare what happened, not generated identifiers: orders and outcomes, retreats, builds and final ownership.
  const strip=(reports:PublicPhaseReport[])=>JSON.stringify(reports.map(r=>[r.year,r.season,r.phase,r.phase==='ORDERS'?r.resolvedOrders.map(o=>`${o.id} ${o.resolution}`).sort()
    :r.phase==='RETREATS'?r.retreats.map(x=>`${x.fromTerritory}>${x.toTerritory} ${x.outcome}`).sort():r.adjustments.map(x=>`${x.power} ${x.builds.map(b=>b.type+b.territory).sort()} -${x.disbandedUnits.map(u=>u.territory).sort()}`),r.after.territoryOwners]));
  const a=await play(t,'bot-game-a'),again=await play(t,'bot-game-a'),other=await play(t,'bot-game-b');
  assert.equal(strip(a.reports),strip(again.reports));
  assert.notEqual(strip(a.reports),strip(other.reports));
  const bot=practiceBot(new PhaseRules()),fixture=await importScenario(JSON.parse(await readFile(new URL('../../fixtures/development/tunis-expedition.v1.json',import.meta.url),'utf8')));
  const job={operationId:'op',attemptId:'x',phaseId:'x:1901:SPRING:ORDERS',revision:1,status:'DECIDING',playerId:'p',requestId:'r',board:fixture.board,definition:challengeDefinition(fixture)!,
    humanAction:{phase:'ORDERS',orderIds:[]},decisions:null,reportOffset:0,createdAt:0} as PhaseJob;
  assert.deepEqual(await bot.recover({job,signal:signal()}),await bot.decide({job,signal:signal()}));
  // It never looks at what the human submitted.
  assert.deepEqual(await bot.decide({job:{...job,humanAction:{phase:'ORDERS',orderIds:['ANK|MOVE|CON']}},signal:signal()}),await bot.decide({job,signal:signal()}));
});

test('every rotation scenario and the coast, convoy, retreat and build fixtures are playable against the bot without a stall',async t=>{
  for(const scenario of ['belgian-landing','iberian-march','adriatic-descent','danish-straits','sicilian-crossing']){
    const {attempt,reports}=await play(t,`bot-${scenario}`,scenario);
    assert.equal(attempt.lifecycle,'COMPLETED',scenario);assert.ok(reports.length>=4,scenario);
  }
  const rules=new PhaseRules(),bot=practiceBot(rules);
  for(const name of ['split-coast','allied-convoy','supported-attack','circular-moves','retreat-position','winter-build']){
    const raw=JSON.parse(await readFile(new URL(`../../fixtures/development/${name}.v1.json`,import.meta.url),'utf8'));
    raw.objective={humanPower:'TURKEY',territory:'TUN',deadlineYear:1905,earlyAchievementYear:1902};
    const fixture=await importScenario(raw),job={operationId:'op',attemptId:name,phaseId:`${name}:p`,revision:1,status:'DECIDING',playerId:'p',requestId:'r',board:fixture.board,definition:challengeDefinition(fixture)!,
      humanAction:{phase:fixture.board.phase,...(fixture.board.phase==='ORDERS'?{orderIds:[]}:fixture.board.phase==='RETREATS'?{retreats:{}}:{builds:[],disbands:[]})},decisions:null,reportOffset:0,createdAt:0} as PhaseJob;
    const decisions=await bot.decide({job,signal:signal()});
    // The engine accepts every decision exactly as produced.
    await rules.validateDecisions(job,decisions,signal());
    if(name==='retreat-position')assert.ok(Object.values(decisions).some(d=>d!.phase==='RETREATS'&&Object.values(d!.retreats).some(x=>x!==null)),'a dislodged unit retreats rather than disbanding');
    if(name==='winter-build')assert.ok(Object.values(decisions).some(d=>d!.phase==='BUILDS'&&d!.builds.length>0),'an owed build is taken');
  }
});

test('bot practice is its own pinned mode over HTTP: labelled, free, never sponsored and never converted',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-bot-http-')),store=await Store.open(join(dir,'game.sqlite'));let now=Date.parse('2027-01-01T12:00:00Z');
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4)},config=readRuntimeConfig(env);
  const auth=new AuthService(store,config,env,undefined,()=>now),service=await ChallengeService.open(store,config,()=>now);
  const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api',service.router(auth));
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address==='object');
  const player=await store.call('identity',{provider:'github',subject:'bot-http',displayName:'Test',now}),cookie=`${auth.cookieName}=${newToken()}`;
  await store.call('createSession',{tokenHash:auth.tokenHash(cookie)!,playerId:player.id,now,expiresAt:now+86_400_000});
  const call=(route:string,body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const start={requestId:'b-1',challengeId:'tunis-expedition',challengeVersion:1,mode:'BOT'};
  const attempt=await (await call('/attempts',start)).json() as ChallengeAttemptView;
  assert.deepEqual([attempt.mode,attempt.challenge.mode,attempt.challenge.opponentLabel,attempt.notice],['BOT','BOT','Practice bot · free scripted opponents, no AI model',null]);
  assert.equal((await (await call('/attempts',start)).json()).id,attempt.id);
  for(const mode of ['PRACTICE','SPONSORED'])assert.equal((await call('/attempts',{...start,mode})).status,409,mode);
  assert.equal((await call('/attempts',{requestId:'b-1',challengeId:'tunis-expedition',challengeVersion:1})).status,409);
  const legal=await (await call(`/attempts/${attempt.id}/legal`)).json() as ChallengeLegalCatalog;
  assert.equal((await call(`/attempts/${attempt.id}/orders`,{revision:0,phaseId:attempt.phaseId,requestId:'o-1',action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}})).status,200);
  await service.attempts.wait(attempt.id);
  const after=await (await call(`/attempts/${attempt.id}`)).json() as ChallengeAttemptView;
  assert.deepEqual([after.board.season,after.execution,after.mode],['FALL','ACCEPTING','BOT']);
  const [report]=(await (await call(`/attempts/${attempt.id}/reports`)).json()).reports as PublicPhaseReport[];
  assert.ok(report.phase==='ORDERS'&&report.resolvedOrders.filter(o=>o.power!=='TURKEY'&&o.type==='MOVE').length>=10);
  assert.equal((await store.call('providerCallsForAttempt',{attemptId:attempt.id})).length,0);
  assert.equal((await store.call('attempt',{id:attempt.id}))!.preset,null);
});
