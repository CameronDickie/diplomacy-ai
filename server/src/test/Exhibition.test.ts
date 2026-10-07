import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { ExhibitionReplay,ExhibitionSummary,PublicPhaseReport } from '@diplomacy/shared';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { Store,newToken } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { ExhibitionService } from '../exhibition/ExhibitionService.js';
import { ExhibitionRunner } from '../exhibition/ExhibitionRunner.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { canonicalJson } from '../fixtures/BoardFixture.js';

const DAY=86_400_000;
async function setup(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-exhibition-'));let now=Date.parse('2027-01-01T12:00:00Z');
  const path=join(dir,'game.sqlite');let store=await Store.open(path);
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4),DIPLOMACY_ADMIN_GITHUB_USER_IDS:'900000000017'};
  const config=readRuntimeConfig(env),auth=new AuthService(store,config,env,undefined,()=>now);
  // Opening the challenge service registers the scenarios an exhibition can be started from.
  const challenges=await ChallengeService.open(store,config,()=>now),service=new ExhibitionService(store,config,()=>now);
  const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api',service.router(auth));app.use('/api',challenges.router(auth));
  const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  const request=(route:string,cookie='',body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function user(subject:string){
    const player=await store.call('identity',{provider:'github',subject,displayName:'Test',now});
    const cookie=`${auth.cookieName}=${newToken()}`;
    await store.call('createSession',{tokenHash:auth.tokenHash(cookie)!,playerId:player.id,now,expiresAt:now+DAY});return {player,cookie};
  }
  const create=(id:string,maxPhases=12)=>store.call('createExhibition',{id,challengeId:'tunis-expedition',challengeVersion:1,maxPhases,createdBy:'test',maxRunning:2,now});
  const runner=(options:ConstructorParameters<typeof ExhibitionRunner>[2]={})=>{const r=new ExhibitionRunner(store,new PhaseRules(),{now:()=>now,...options});t.after(()=>r.close());return r;};
  const finish=async(r:ExhibitionRunner,id:string)=>{for(let i=0;i<200&&(await store.call('exhibition',{id}))!.state==='RUNNING';i++)await r.tick();return (await store.call('exhibition',{id}))!;};
  const count=(table:string)=>{const db=new DatabaseSync(path,{readOnly:true});try{return Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);}finally{db.close();}};
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));await service.close();await challenges.close();await store.close();await rm(dir,{recursive:true,force:true});});
  return {path,request,user,create,runner,finish,count,service,get store(){return store;},now:()=>now,advance:(ms:number)=>{now+=ms;}};
}
const events=(reports:PublicPhaseReport[])=>JSON.stringify(reports.map(r=>[r.sequence,r.year,r.season,r.phase,r.phase==='ORDERS'?r.resolvedOrders.map(o=>`${o.id} ${o.resolution}`).sort():null,r.after.territoryOwners]));

test('a bot-only game runs in the background to a defined end with contiguous public reports, no cost and no attempt',async t=>{
  const f=await setup(t),runner=f.runner();
  await f.create('game-a',14);
  const done=await f.finish(runner,'game-a'),reports=await f.store.call('exhibitionReports',{id:'game-a'});
  assert.deepEqual([done.state,done.reason,done.phases],['COMPLETED','PHASE_LIMIT',14]);
  assert.deepEqual(reports.map(r=>r.sequence),Array.from({length:14},(_,i)=>i+1));
  for(let i=1;i<reports.length;i++)assert.equal(canonicalJson(reports[i].before),canonicalJson(reports[i-1].after),`report ${i+1}`);
  assert.equal(canonicalJson(reports.at(-1)!.after.territoryOwners),canonicalJson(done.board.territoryOwners));
  // Every power, including the scenario's human seat, was played: Turkey moved too.
  assert.ok(reports.some(r=>r.phase==='ORDERS'&&r.resolvedOrders.some(o=>o.power==='TURKEY'&&o.type==='MOVE')));
  assert.ok(reports.some(r=>r.phase==='BUILDS'));
  assert.deepEqual([f.count('attempts'),f.count('provider_calls'),f.count('reservations'),(await f.store.call('fundingTotals',{})).settledNanousd],[0,0,0,0]);
  // Once finished, further ticks do nothing.
  assert.equal(await runner.tick(),0);assert.equal(f.count('exhibition_reports'),14);
});

test('a game is reproducible from its ID, survives a runner restart and cannot commit a phase twice with two runners',async t=>{
  const f=await setup(t),g=await setup(t);
  await f.create('same-id',10);await g.create('same-id',10);await g.create('other-id',10);
  // One side stops its runner part-way and continues with a new one; the other uses two runners at once on separate connections.
  const first=f.runner({stepsPerTick:1});for(let i=0;i<4;i++)await first.tick();await first.close();
  assert.equal((await f.store.call('exhibition',{id:'same-id'}))!.phases,4);
  const interrupted=await f.finish(f.runner(),'same-id');
  const second=await Store.open(g.path);t.after(()=>second.close());
  const a=g.runner({stepsPerTick:1}),b=new ExhibitionRunner(second,new PhaseRules(),{now:g.now,stepsPerTick:1});t.after(()=>b.close());
  for(let i=0;i<40&&((await g.store.call('exhibition',{id:'same-id'}))!.state==='RUNNING'||(await g.store.call('exhibition',{id:'other-id'}))!.state==='RUNNING');i++)await Promise.all([a.tick(),b.tick()]);
  const raced=(await g.store.call('exhibition',{id:'same-id'}))!;
  assert.deepEqual([interrupted.state,interrupted.phases,raced.state,raced.phases],['COMPLETED',10,'COMPLETED',10]);
  const left=await f.store.call('exhibitionReports',{id:'same-id'}),right=await g.store.call('exhibitionReports',{id:'same-id'});
  assert.equal(left.length,10);assert.equal(right.length,10);
  assert.equal(events(left),events(right));
  assert.notEqual(events(right),events(await g.store.call('exhibitionReports',{id:'other-id'})));
  // A stale commit for a phase that already exists is refused.
  await assert.rejects(g.store.call('advanceExhibition',{id:'same-id',expectedPhases:3,board:raced.board,report:right[3],finished:false,quietLimit:16,now:g.now()}),{code:'STORE_CONFLICT'});
});

test('pause, resume, cancel, the phase cap, the no-progress rule and the unfinished-game limit all hold',async t=>{
  const f=await setup(t),runner=f.runner({stepsPerTick:1});
  await f.create('paused',6);await runner.tick();
  const state=(id:string,action:'PAUSE'|'RESUME'|'CANCEL')=>f.store.call('setExhibitionState',{id,action,now:f.now()});
  assert.equal((await state('paused','PAUSE')).state,'PAUSED');assert.equal((await state('paused','PAUSE')).state,'PAUSED');
  assert.equal(await runner.tick(),0);assert.equal((await f.store.call('exhibition',{id:'paused'}))!.phases,1);
  // Paused games still count toward the limit of unfinished games.
  await f.create('second',6);await assert.rejects(f.create('third',6),{code:'STORE_CONFLICT'});
  assert.equal((await f.create('second',6)).id,'second');
  assert.equal((await state('second','CANCEL')).reason,'CANCELLED_BY_OPERATOR');
  assert.equal((await state('paused','RESUME')).state,'RUNNING');
  assert.deepEqual([(await f.finish(runner,'paused')).state,(await f.store.call('exhibition',{id:'paused'}))!.phases],['COMPLETED',6]);
  for(const action of ['PAUSE','RESUME','CANCEL'] as const)await assert.rejects(state('paused',action),{code:'STORE_CONFLICT'});
  await assert.rejects(state('missing','PAUSE'),{code:'STORE_CONFLICT'});
  assert.equal((await state('second','CANCEL')).state,'CANCELLED');
  // With a quiet limit of one, the first phase in which nothing changes hands ends the game as a draw.
  await f.create('quiet',50);
  const stalled=await f.finish(f.runner({quietLimit:1}),'quiet');
  assert.deepEqual([stalled.state,stalled.reason,stalled.phases],['STALLED','NO_PROGRESS',1]);
  for(const bad of [{maxPhases:0},{maxPhases:201},{maxPhases:1.5},{challengeId:'no-such-scenario'},{challengeVersion:9}])
    await assert.rejects(f.store.call('createExhibition',{id:`bad-${JSON.stringify(bad).length}`,challengeId:'tunis-expedition',challengeVersion:1,maxPhases:10,createdBy:'test',maxRunning:2,now:f.now(),...bad}),{code:'STORE_INVALID'});
});

test('anyone can watch an exhibition, only the operator can manage one, and finished games age out',async t=>{
  const f=await setup(t),owner=await f.user('900000000017'),player=await f.user('player');
  const body={challengeId:'tunis-expedition',challengeVersion:1,maxPhases:5};
  for(const [route,payload] of [['/operator/exhibitions',body],['/operator/exhibitions/x/pause',{}],['/operator/exhibitions/x/resume',{}],['/operator/exhibitions/x/cancel',{}]] as const){
    assert.equal((await f.request(route,'',payload)).status,401,route);assert.equal((await f.request(route,player.cookie,payload)).status,403,route);
  }
  for(const bad of [{...body,model:'x'},{challengeId:'tunis-expedition'},{...body,maxPhases:'many'},{...body,maxPhases:500},{...body,challengeId:'nope'}])assert.equal((await f.request('/operator/exhibitions',owner.cookie,bad)).status,400,JSON.stringify(bad));
  const started=await (await f.request('/operator/exhibitions',owner.cookie,body)).json() as ExhibitionSummary;
  assert.deepEqual([started.title,started.state,started.phases,started.maxPhases,started.centers.TURKEY],['Tunis expedition','RUNNING',0,5,3]);
  assert.equal((await (await f.request(`/operator/exhibitions/${started.id}/pause`,owner.cookie,{})).json()).state,'PAUSED');
  assert.equal((await (await f.request(`/operator/exhibitions/${started.id}/resume`,owner.cookie,{})).json()).state,'RUNNING');
  assert.equal((await f.request(`/operator/exhibitions/${started.id}/pause`,owner.cookie,{extra:1})).status,400);
  assert.equal((await f.request('/operator/exhibitions/missing/pause',owner.cookie,{})).status,404);
  // The service's own runner plays it; a request never waits for a game.
  for(let i=0;i<10&&(await f.store.call('exhibition',{id:started.id}))!.state==='RUNNING';i++)await f.service.runner.tick();
  const list=await (await f.request('/exhibitions')).json() as {exhibitions:ExhibitionSummary[]};
  assert.deepEqual(list.exhibitions.map(e=>[e.id,e.state,e.reason,e.phases]),[[started.id,'COMPLETED','PHASE_LIMIT',5]]);
  const text=await (await f.request(`/exhibitions/${started.id}`,player.cookie)).text(),replay=JSON.parse(text) as ExhibitionReplay;
  assert.deepEqual([replay.kind,replay.reports.length,replay.exhibition.phases],['EXHIBITION',5,5]);
  for(const secret of ['createdBy','created_by','playerId',owner.player.id,'recent','quiet'])assert.ok(!text.includes(secret),secret);
  assert.equal((await f.request('/exhibitions/missing')).status,404);
  assert.equal((await f.request(`/operator/exhibitions/${started.id}/cancel`,owner.cookie,{})).status,409);
  assert.deepEqual((await f.store.call('operatorOverview',{})).audit.map(a=>a.action),['EXHIBITION_RESUME','EXHIBITION_PAUSE','EXHIBITION_START']);
  // Retention removes a finished game after the result window and never an unfinished one.
  const running=await (await f.request('/operator/exhibitions',owner.cookie,body)).json() as ExhibitionSummary;
  const later=f.now()+31*DAY;
  await f.store.call('sweepRetention',{now:later,resultBefore:later-30*DAY,diagnosticBefore:later-7*DAY,limit:200});
  assert.equal(await f.store.call('exhibition',{id:started.id}),null);assert.equal((await f.store.call('exhibitionReports',{id:started.id})).length,0);
  assert.equal((await f.store.call('exhibition',{id:running.id}))!.state,'RUNNING');
});
