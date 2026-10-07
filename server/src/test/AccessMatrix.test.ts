import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer,type Server } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { Store,newToken } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { OperatorService } from '../operator/OperatorService.js';
import { localDelivery } from '../operator/Notifier.js';
import { ExhibitionService } from '../exhibition/ExhibitionService.js';
import type { ChallengeAttemptView } from '@diplomacy/shared';

/**
 * Who may call each API route. `owner` routes additionally require the attempt to belong to the caller.
 * `valid` is sent by callers who must be refused (a refusal must not depend on a malformed body);
 * `probe` is sent by callers who are allowed, chosen so that passing authorization has no side effect.
 */
type Access = 'public' | 'player' | 'owner' | 'operator';
const MATRIX: Record<string,{access:Access;valid?:unknown;probe?:{body?:unknown;status:number}}> = {
  'GET /challenges': {access:'public'},
  'GET /challenges/demo': {access:'public'},
  'GET /attempts': {access:'player',probe:{status:200}},
  'POST /attempts': {access:'player',valid:{requestId:'matrix',challengeId:'tunis-expedition',challengeVersion:1},probe:{body:{},status:400}},
  'POST /account/delete': {access:'player',valid:{confirm:'DELETE'},probe:{body:{confirm:'no'},status:400}},
  'POST /credit-request': {access:'player',valid:{},probe:{body:{},status:409}},
  'GET /attempts/:id': {access:'owner',probe:{status:200}},
  'GET /attempts/:id/legal': {access:'owner',probe:{status:200}},
  'GET /attempts/:id/reports': {access:'owner',probe:{status:200}},
  'POST /attempts/:id/orders': {access:'owner',valid:{revision:0,phaseId:'p',requestId:'matrix',action:{phase:'ORDERS',orderIds:[]}},probe:{body:{},status:400}},
  'POST /attempts/:id/activity': {access:'owner',valid:{revision:0},probe:{body:{},status:400}},
  'POST /attempts/:id/abandon': {access:'owner',valid:{},probe:{body:{unexpected:1},status:400}},
  'POST /attempts/:id/recover': {access:'owner',valid:{},probe:{body:{unexpected:1},status:400}},
  'GET /operator/overview': {access:'operator',probe:{status:200}},
  'GET /operator/attempts/:id': {access:'operator',probe:{status:200}},
  'POST /operator/paid': {access:'operator',valid:{stopped:true},probe:{body:{stopped:'yes'},status:400}},
  'POST /operator/attempts/:id/stop': {access:'operator',valid:{},probe:{body:{unexpected:1},status:400}},
  'GET /exhibitions': {access:'public'},
  'GET /exhibitions/:id': {access:'public'},
  'POST /operator/exhibitions': {access:'operator',valid:{challengeId:'tunis-expedition',challengeVersion:1},probe:{body:{challengeId:'tunis-expedition'},status:400}},
  'POST /operator/exhibitions/:id/pause': {access:'operator',valid:{},probe:{body:{unexpected:1},status:400}},
  'POST /operator/exhibitions/:id/resume': {access:'operator',valid:{},probe:{body:{unexpected:1},status:400}},
  'POST /operator/exhibitions/:id/cancel': {access:'operator',valid:{},probe:{body:{unexpected:1},status:400}},
  'POST /operator/players/:id/ban': {access:'operator',valid:{banned:true},probe:{body:{banned:'yes'},status:400}},
};
type Layer = {route?:{path:string;methods:Record<string,boolean>}};
const routes = (router:express.Router,prefix=''):string[] => (router.stack as Layer[]).filter(l=>l.route)
  .flatMap(l=>Object.keys(l.route!.methods).map(m=>`${m.toUpperCase()} ${prefix}${l.route!.path}`));

test('every API route is classified and enforces its access class for each kind of caller, before and after restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-access-'));let now=Date.parse('2027-01-01T12:00:00Z');
  const path=join(dir,'game.sqlite');let store=await Store.open(path);
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'test-secret-'.repeat(4),DIPLOMACY_ADMIN_GITHUB_USER_IDS:'4242'};
  const config=readRuntimeConfig(env);
  let auth!:AuthService,service!:ChallengeService,operator!:OperatorService,exhibitions!:ExhibitionService,server!:Server,port=0;
  async function boot(){
    auth=new AuthService(store,config,env,undefined,()=>now);service=await ChallengeService.open(store,config,()=>now);
    operator=new OperatorService(store,config,service.attempts,()=>now,localDelivery);
    exhibitions=new ExhibitionService(store,config,()=>now);
    const challengeRouter=service.router(auth),operatorRouter=operator.router(auth),exhibitionRouter=exhibitions.router(auth);
    const app=express();app.use(express.json());app.use('/api',auth.httpBoundary);app.use('/api',exhibitionRouter);app.use('/api/operator',operatorRouter);app.use('/api',challengeRouter);
    server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address==='object');port=address.port;
    return [...routes(challengeRouter),...routes(operatorRouter,'/operator'),...routes(exhibitionRouter)];
  }
  async function halt(){await new Promise<void>(done=>server.close(()=>done()));await exhibitions.close();await operator.close();await service.close();}
  t.after(async()=>{await halt();await store.close();await rm(dir,{recursive:true,force:true});});
  // A new endpoint must be added to MATRIX, or this fails before anything else runs.
  assert.deepEqual((await boot()).sort(),Object.keys(MATRIX).sort());

  async function user(subject:string,provider:'github'|'google'='github',ttl=86_400_000){
    const player=await store.call('identity',{provider,subject,displayName:'Test',now});
    const cookie=`${auth.cookieName}=${newToken()}`,tokenHash=auth.tokenHash(cookie)!;
    await store.call('createSession',{tokenHash,playerId:player.id,now,expiresAt:now+ttl});return {player,cookie,tokenHash};
  }
  const call=(key:string,cookie:string,body:unknown,ids:{attempt:string;player:string})=>{
    const [method,route]=key.split(' '),target=route.replace('/players/:id',`/players/${ids.player}`).replace('/exhibitions/:id','/exhibitions/matrix-game').replace(':id',ids.attempt);
    return fetch(`http://127.0.0.1:${port}/api${target}`,{method,headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body??{})}:{})});
  };
  const owner=await user('owner'),other=await user('other'),admin=await user('4242'),lookalike=await user('4242','google');
  const revokedAdmin=await user('4242'),expired=await user('expiring','github',1000),banned=await user('banned');
  const attempt=await (await call('POST /attempts',owner.cookie,MATRIX['POST /attempts'].valid,{attempt:'',player:''})).json() as ChallengeAttemptView;
  // A paused bot game exists so its public and operator routes have a real target.
  await store.call('createExhibition',{id:'matrix-game',challengeId:'tunis-expedition',challengeVersion:1,maxPhases:5,createdBy:'test',maxRunning:2,now});
  await store.call('setExhibitionState',{id:'matrix-game',action:'PAUSE',now});
  await store.call('revokeSession',{tokenHash:revokedAdmin.tokenHash,now});
  await service.attempts.banPlayer(banned.player.id);
  now+=2000;
  const ids={attempt:attempt.id,player:other.player.id};
  const snapshot=async()=>JSON.stringify([await store.call('attempt',{id:attempt.id}),await store.call('paidState',{}),await store.call('activeAttempts',{}),await store.call('exhibitions',{limit:10}),
    await Promise.all([owner,other,admin].map(async u=>(await store.call('session',{tokenHash:u.tokenHash,now}))?.player))]);

  async function sweep(label:string){
    const before=await snapshot();
    for(const [key,rule] of Object.entries(MATRIX)){
      const expect=async(who:string,cookie:string,status:number|number[],body:unknown=rule.valid)=>{
        const response=await call(key,cookie,body,ids);
        assert.ok(([] as number[]).concat(status).includes(response.status),`${label}: ${who} ${key} → ${response.status}`);
      };
      if(rule.access==='public'){for(const [who,cookie] of [['guest',''],['player',owner.cookie],['revoked',revokedAdmin.cookie]])await expect(who,cookie,200);continue;}
      for(const [who,cookie] of [['guest',''],['revoked operator',revokedAdmin.cookie],['expired session',expired.cookie],['banned player',banned.cookie],['unknown cookie',`${auth.cookieName}=${newToken()}`]])await expect(who,cookie,401);
      if(rule.access==='operator'){
        for(const [who,cookie] of [['player',owner.cookie],['other player',other.cookie],['Google look-alike',lookalike.cookie]])await expect(who,cookie,403);
        await expect('operator',admin.cookie,rule.probe!.status,rule.probe!.body);
      } else if(rule.access==='owner'){
        // Being an operator confers nothing on a player's own routes.
        for(const [who,cookie] of [['other player',other.cookie],['operator',admin.cookie]])await expect(who,cookie,404);
        await expect('owner',owner.cookie,rule.probe!.status,rule.probe!.body);
      } else await expect('player',owner.cookie,rule.probe!.status,rule.probe!.body);
    }
    // No refused or probing request changed anything.
    assert.equal(await snapshot(),before,label);
  }
  await sweep('first boot');
  // Sessions, bans and the allowlist are durable: a restarted API with new in-memory state decides identically.
  await halt();await store.close();store=await Store.open(path);await boot();
  await sweep('after restart');
});
