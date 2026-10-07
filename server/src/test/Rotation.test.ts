import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { Store,newToken } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { featuredSlot,parseRotation,type RotationManifest } from '../challenge/Catalog.js';
import { FixtureError } from '../fixtures/BoardFixture.js';
import { challengeDefinition,importScenario } from '../fixtures/ScenarioFixture.js';
import type { ChallengeAttemptView,ChallengeCatalog,ChallengeLegalCatalog,ChallengeReplay } from '@diplomacy/shared';

const DAY=86_400_000,at=(iso:string)=>Date.parse(iso);
const fixtureFile=(path:string)=>readFile(new URL(`../../fixtures/${path}`,import.meta.url),'utf8').then(JSON.parse);

test('the featured slot is a pure function of the UTC day, wraps in both directions and changes exactly at midnight',()=>{
  const manifest:RotationManifest={schemaVersion:1,id:'test',version:1,epochDay:'2027-01-01',entries:['a','b','c'].map(id=>({id,version:1}))};
  assert.deepEqual(featuredSlot(manifest,at('2027-01-01T00:00:00.000Z')),{index:0,day:'2027-01-01',nextChangeAt:at('2027-01-02T00:00:00Z')});
  assert.equal(featuredSlot(manifest,at('2027-01-01T23:59:59.999Z')).index,0);
  assert.deepEqual(featuredSlot(manifest,at('2027-01-02T00:00:00.000Z')),{index:1,day:'2027-01-02',nextChangeAt:at('2027-01-03T00:00:00Z')});
  assert.deepEqual([3,4,5,6].map(d=>featuredSlot(manifest,at('2027-01-01T12:00:00Z')+d*DAY).index),[0,1,2,0]);
  // Days before the epoch continue the same cycle backwards rather than going negative.
  assert.deepEqual([1,2,3,4].map(d=>featuredSlot(manifest,at('2027-01-01T12:00:00Z')-d*DAY).index),[2,1,0,2]);
  // Leap day and a year boundary are ordinary days.
  assert.equal(featuredSlot(manifest,at('2028-02-29T12:00:00Z')).day,'2028-02-29');
  assert.equal(featuredSlot(manifest,at('2028-03-01T00:00:00Z')).index,(featuredSlot(manifest,at('2028-02-29T00:00:00Z')).index+1)%3);
  assert.equal(featuredSlot({...manifest,entries:[{id:'only',version:1}]},at('2031-06-01T00:00:00Z')).index,0);
});

test('rotation manifests reject unknown fields, bad dates, empty or duplicate entries',()=>{
  const good={schemaVersion:1,id:'dev',version:1,epochDay:'2027-01-01',entries:[{id:'a',version:1},{id:'a',version:2}]};
  assert.deepEqual(parseRotation(good),good);
  for(const bad of [{...good,extra:1},{...good,schemaVersion:2},{...good,id:'Bad Id'},{...good,version:0},{...good,epochDay:'2027-02-30'},{...good,epochDay:'01/01/2027'},
    {...good,entries:[]},{...good,entries:[{id:'a',version:1},{id:'a',version:1}]},{...good,entries:[{id:'a',version:1,model:'x'}]},{...good,entries:[{id:'a',version:'1'}]},null,'text'])
    assert.throws(()=>parseRotation(bad),FixtureError,JSON.stringify(bad));
});

test('the shipped development rotation lists distinct scored scenarios whose witnesses succeed and fail as labelled',async()=>{
  const manifest=parseRotation(await fixtureFile('rotation/development.v1.json'));
  assert.ok(manifest.entries.length>=2);
  const powers=new Set<string>();
  for(const entry of manifest.entries){
    const fixture=await importScenario(await fixtureFile(`development/${entry.id}.v${entry.version}.json`)),definition=challengeDefinition(fixture);
    assert.ok(definition,entry.id);assert.equal(fixture.version,entry.version);assert.equal(fixture.provenance,'AI_GENERATED_DEVELOPMENT');
    assert.deepEqual(fixture.witnesses.map(w=>[w.name,w.expectedOutcome]),[['early-capture','SUCCESS'],['deadline-hold','FAILURE']],entry.id);
    powers.add(definition.humanPower);
  }
  // Each day asks the player to command a different power.
  assert.equal(powers.size,manifest.entries.length);
});

async function setup(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-rotation-'));let now=at('2027-01-01T23:50:00Z');
  const path=join(dir,'game.sqlite');let store=await Store.open(path);
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4)};
  const config=readRuntimeConfig(env);let service!:ChallengeService,auth!:AuthService,close!:()=>Promise<void>,port=0;
  async function boot(){
    auth=new AuthService(store,config,env,undefined,()=>now);service=await ChallengeService.open(store,config,()=>now);
    const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api',service.router(auth));
    const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address==='object');port=address.port;
    close=async()=>{await new Promise<void>(done=>server.close(()=>done()));await service.close();};
  }
  await boot();
  const request=(route:string,cookie='',body?:unknown)=>fetch(`http://127.0.0.1:${port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  async function user(subject:string){
    const player=await store.call('identity',{provider:'github',subject,displayName:'Test',now});
    const cookie=`${auth.cookieName}=${newToken()}`;
    await store.call('createSession',{tokenHash:auth.tokenHash(cookie)!,playerId:player.id,now,expiresAt:now+6*DAY});return {player,cookie};
  }
  const catalog=async()=>await (await request('/challenges')).json() as ChallengeCatalog;
  t.after(async()=>{await close();await store.close();await rm(dir,{recursive:true,force:true});});
  return {request,user,catalog,get service(){return service;},get store(){return store;},now:()=>now,set:(iso:string)=>{now=at(iso);},advance:(ms:number)=>{now+=ms;},
    async restart(){await close();await store.close();store=await Store.open(path);await boot();}};
}

test('the catalog and replay change at midnight UTC while an attempt stays pinned to its challenge across rotation and restart',async t=>{
  const f=await setup(t),player=await f.user('player');
  const before=await f.catalog();
  assert.deepEqual(before.rotation,{id:'development-rotation',version:1,label:'DEVELOPMENT_ROTATION',day:'2027-01-01',index:0,size:6,nextChangeAt:at('2027-01-02T00:00:00Z')});
  assert.equal(before.challenges.length,1);
  assert.deepEqual([before.challenges[0].id,before.challenges[0].humanPower,before.challenges[0].targetTerritory],['tunis-expedition','TURKEY','TUN']);
  const yesterday={requestId:'start-1',challengeId:before.challenges[0].id,challengeVersion:before.challenges[0].version};
  // Only the featured challenge can be started, even though the others are registered.
  assert.equal((await f.request('/attempts',player.cookie,{...yesterday,requestId:'other',challengeId:'belgian-landing'})).status,409);
  assert.equal((await f.request('/attempts',player.cookie,{...yesterday,requestId:'bogus',challengeId:'no-such-challenge'})).status,400);
  assert.equal((await f.request('/attempts',player.cookie,{...yesterday,requestId:'bogus',challengeVersion:2})).status,400);
  assert.equal((await f.store.call('activeAttempts',{})).length,0);
  const attempt=await (await f.request('/attempts',player.cookie,yesterday)).json() as ChallengeAttemptView;
  assert.equal(attempt.challenge.id,'tunis-expedition');
  f.set('2027-01-01T23:59:59.999Z');
  assert.equal((await f.catalog()).challenges[0].id,'tunis-expedition');
  assert.equal((await (await f.request('/challenges/demo')).json() as ChallengeReplay).challenge.id,'tunis-expedition');
  f.advance(1);
  const after=await f.catalog();
  assert.deepEqual([after.rotation.day,after.rotation.index,after.challenges[0].id,after.challenges[0].humanPower],['2027-01-02',1,'belgian-landing','ENGLAND']);
  const demo=await (await f.request('/challenges/demo')).json() as ChallengeReplay;
  assert.equal(demo.challenge.id,'belgian-landing');assert.equal(demo.reports.at(-1)!.after.territoryOwners.BEL,'ENGLAND');
  // The attempt begun before midnight is still yesterday's challenge and still playable.
  const pinned=await (await f.request(`/attempts/${attempt.id}`,player.cookie)).json() as ChallengeAttemptView;
  assert.deepEqual([pinned.challenge.id,pinned.challenge.humanPower,pinned.lifecycle],['tunis-expedition','TURKEY','ACTIVE']);
  const legal=await (await f.request(`/attempts/${attempt.id}/legal`,player.cookie)).json() as ChallengeLegalCatalog;
  assert.ok(legal.options.every(o=>o.order.power==='TURKEY'));
  assert.equal((await f.request(`/attempts/${attempt.id}/orders`,player.cookie,{revision:pinned.revision,phaseId:pinned.phaseId,requestId:'orders-1',action:{phase:'ORDERS',orderIds:legal.options.filter(o=>o.order.type==='HOLD').map(o=>o.id)}})).status,200);
  await f.service.attempts.wait(attempt.id);
  // A retry of yesterday's accepted start returns that attempt; a fresh start of yesterday's card is refused without consuming anything.
  assert.equal((await (await f.request('/attempts',player.cookie,yesterday)).json()).id,attempt.id);
  const stale=await f.request('/attempts',player.cookie,{...yesterday,requestId:'stale-tab'});
  assert.equal(stale.status,409);assert.match((await stale.json()).message,/changed/);
  await f.restart();
  const again=await (await f.request(`/attempts/${attempt.id}`,player.cookie)).json() as ChallengeAttemptView;
  assert.deepEqual([again.challenge.id,again.board.season,again.lifecycle],['tunis-expedition','FALL','ACTIVE']);
  assert.equal((await f.catalog()).challenges[0].id,'belgian-landing');
  // Finishing yesterday's attempt frees the account to start today's, which pins the new definition.
  await f.request(`/attempts/${attempt.id}/abandon`,player.cookie,{});
  const today=await (await f.request('/attempts',player.cookie,{requestId:'today-1',challengeId:'belgian-landing',challengeVersion:1})).json() as ChallengeAttemptView;
  assert.deepEqual([today.challenge.id,today.challenge.humanPower,today.challenge.targetTerritory,today.challenge.deadlineYear],['belgian-landing','ENGLAND','BEL',1902]);
  const history=await (await f.request('/attempts',player.cookie)).json() as {attempts:ChallengeAttemptView[]};
  assert.deepEqual(history.attempts.map(a=>a.challenge.id),['belgian-landing','tunis-expedition']);
});

test('a full cycle features every scenario once, serves a winning replay for each and then repeats',async t=>{
  const f=await setup(t);f.set('2027-01-01T12:00:00Z');
  const seen:string[]=[];
  for(let day=0;day<7;day++){
    const catalog=await f.catalog(),card=catalog.challenges[0],demo=await (await f.request('/challenges/demo')).json() as ChallengeReplay;
    assert.equal(demo.challenge.id,card.id);assert.equal(demo.kind,'REFERENCE');
    const last=demo.reports.at(-1)!;
    assert.equal(last.after.territoryOwners[card.targetTerritory],card.humanPower,card.id);assert.ok(last.year<=card.earlyAchievementYear);
    seen.push(card.id);f.advance(DAY);
  }
  assert.equal(new Set(seen.slice(0,6)).size,6);assert.equal(seen[6],seen[0]);
});
