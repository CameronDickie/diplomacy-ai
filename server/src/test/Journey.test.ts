import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { Store } from '../storage/Store.js';
import { AuthService } from '../auth.js';
import { OAuthProvider } from '../auth/provider.js';
import { ChallengeService } from '../challenge/ChallengeService.js';
import { OperatorService } from '../operator/OperatorService.js';
import { localDelivery } from '../operator/Notifier.js';
import { mockLunaTransport } from '../luna/Transport.js';
import type { ChallengeAttemptView,ChallengeCatalog,ChallengeLegalCatalog,ChallengeReplay,OperatorAttemptDetail,OperatorOverview,PlayerSession,PublicPhaseReport } from '@diplomacy/shared';

const OWNER_ID=900000000017;
/**
 * One visitor-to-operator story through the real HTTP surface, with a mocked GitHub exchange and
 * the mock opponent transport. It is the integration evidence for the release checklist: every
 * step below is something a person does in the product.
 */
test('journey: public page, sign-in, a practice win, a sponsored attempt, operator oversight, pause and credit request, deletion',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'diplomacy-journey-'));let now=Date.parse('2027-01-01T12:00:00Z');
  const path=join(dir,'game.sqlite');let store=await Store.open(path);
  const env={DIPLOMACY_PROFILE:'showcase',DIPLOMACY_AUTH_SESSION_SECRET:'journey-secret-'.repeat(3),DIPLOMACY_GITHUB_CLIENT_ID:'github-client',DIPLOMACY_GITHUB_CLIENT_SECRET:'github-secret',DIPLOMACY_ADMIN_GITHUB_USER_IDS:String(OWNER_ID)};
  const config=readRuntimeConfig(env);let githubId=555001;const providerCalls:string[]=[];
  const github=new OAuthProvider(async url=>{
    providerCalls.push(String(url));
    const body=String(url)==='https://github.com/login/oauth/access_token'?{access_token:'never-stored',token_type:'bearer'}:String(url)==='https://api.github.com/user'?{id:githubId,login:`user-${githubId}`,email:'private@example.test'}:null;
    if(!body)throw new Error('Unexpected provider endpoint');
    return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  });
  const lunaBodies:string[]=[],mock=mockLunaTransport({pick:'seeded',seed:3});
  let auth!:AuthService,service!:ChallengeService,operator!:OperatorService,close!:()=>Promise<void>,port=0;
  async function boot(){
    auth=new AuthService(store,config,env,github,()=>now);
    service=await ChallengeService.open(store,config,()=>now,{lunaTransport:async request=>{lunaBodies.push(request.body);return mock(request);}});
    operator=new OperatorService(store,config,service.attempts,()=>now,localDelivery);
    const app=express();app.use(express.json({limit:'64kb'}));app.use('/api',auth.httpBoundary);app.use('/api/auth',auth.router());app.use('/api/operator',operator.router(auth));app.use('/api',service.router(auth));
    const server=createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address==='object');port=address.port;
    close=async()=>{await new Promise<void>(done=>server.close(()=>done()));await operator.close();await service.close();};
  }
  await boot();
  t.after(async()=>{await close();await store.close();await rm(dir,{recursive:true,force:true});});
  const call=(route:string,cookie='',body?:unknown)=>fetch(`http://127.0.0.1:${port}/api${route}`,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{Cookie:cookie,Origin:config.returnOrigin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const json=async<T>(route:string,cookie='',body?:unknown)=>await (await call(route,cookie,body)).json() as T;
  async function signIn(id:number){
    githubId=id;
    const begin=await fetch(`http://127.0.0.1:${port}/api/auth/github`,{redirect:'manual'}),flow=begin.headers.getSetCookie()[0].split(';')[0];
    const state=new URL(begin.headers.get('location')!).searchParams.get('state')!;
    const done=await fetch(`http://127.0.0.1:${port}/api/auth/github/callback?code=code&state=${state}`,{redirect:'manual',headers:{Cookie:flow}});
    assert.equal(done.headers.get('location'),`${config.returnOrigin}/`);
    return done.headers.getSetCookie().find(c=>c.startsWith(`${auth.cookieName}=`))!.split(';')[0];
  }
  /** Submits the named moves where legal and holds with every other unit, then waits for the result. */
  async function turn(cookie:string,id:string,wanted:string[]=[]){
    const view=await json<ChallengeAttemptView>(`/attempts/${id}`,cookie),legal=await json<ChallengeLegalCatalog>(`/attempts/${id}/legal`,cookie);
    const units=[...new Set(legal.options.map(o=>o.unitTerritory))];
    const orderIds=units.map(u=>legal.options.find(o=>o.unitTerritory===u&&wanted.includes(o.id))?.id??legal.options.find(o=>o.unitTerritory===u&&o.order.type==='HOLD')!.id);
    const command={revision:view.revision,phaseId:view.phaseId,requestId:`turn-${view.revision}`,action:{phase:'ORDERS',orderIds}};
    assert.equal((await call(`/attempts/${id}/orders`,cookie,command)).status,200);
    await service.attempts.wait(id);
    return {view:await json<ChallengeAttemptView>(`/attempts/${id}`,cookie),command};
  }

  // 1. A visitor with no account reads the challenge and watches the replay, and can do nothing else.
  const catalog=await json<ChallengeCatalog>('/challenges');
  assert.deepEqual([catalog.challenges[0].title,catalog.challenges[0].humanPower,catalog.challenges[0].targetTerritory,catalog.sponsoredPlay,catalog.capacity],['Tunis expedition','TURKEY','TUN','OPEN','OPEN']);
  const replay=await json<ChallengeReplay>('/challenges/demo');
  assert.equal(replay.reports.at(-1)!.after.territoryOwners.TUN,'TURKEY');
  for(const [route,body] of [['/attempts',{}],['/attempts',undefined],['/operator/overview',undefined],['/account/delete',{confirm:'DELETE'}],['/credit-request',{}]] as const)assert.equal((await call(route,'',body)).status,401,route);

  // 2. They sign in with GitHub. No provider token is kept and they are an ordinary player.
  const player=await signIn(555001),session=await json<PlayerSession>('/auth/session',player);
  assert.deepEqual([session.authenticated,session.operator,session.user?.provider],[true,false,'github']);
  assert.equal(providerCalls.length,2);

  // 3. They start the practice challenge, reload mid-way, and win it early.
  const card=catalog.challenges[0],practice=await json<ChallengeAttemptView>('/attempts',player,{requestId:'start-practice',challengeId:card.id,challengeVersion:card.version});
  assert.deepEqual([practice.mode,practice.lifecycle,practice.board.year,practice.board.season],['PRACTICE','ACTIVE',1901,'SPRING']);
  const first=await turn(player,practice.id,['SMY|MOVE|ARM','CON|MOVE|SMY','ANK|MOVE|CON']);
  assert.equal(first.view.board.season,'FALL');
  // A reload is just another read; a repeated submission is the same receipt, not a second turn.
  assert.equal((await json<{attempts:ChallengeAttemptView[]}>('/attempts',player)).attempts[0].board.season,'FALL');
  assert.equal((await json<{status:string}>(`/attempts/${practice.id}/orders`,player,first.command)).status,'ACCEPTED');
  await turn(player,practice.id,['CON|MOVE|AEG']);await turn(player,practice.id,['AEG|MOVE|ION']);
  const won=(await turn(player,practice.id,['ION|MOVE|TUN'])).view;
  assert.deepEqual([won.lifecycle,won.score?.outcome,won.score?.completedYear,won.score?.achievementIds],['COMPLETED','SUCCESS',1902,['EARLY_CAPTURE']]);
  const practiceReports=(await json<{reports:PublicPhaseReport[]}>(`/attempts/${practice.id}/reports`,player)).reports;
  assert.deepEqual(practiceReports.map(r=>`${r.year} ${r.season}`),['1901 SPRING','1901 FALL','1902 SPRING','1902 FALL']);
  assert.equal(lunaBodies.length,0);
  assert.equal((await call(`/attempts/${practice.id}/orders`,player,{...first.command,requestId:'after-the-end'})).status,409);

  // 4. The server restarts. Their session and the finished result are still there.
  await close();await store.close();store=await Store.open(path);await boot();
  const afterRestart=await json<ChallengeAttemptView>(`/attempts/${practice.id}`,player);
  assert.deepEqual([afterRestart.lifecycle,afterRestart.score?.outcome],['COMPLETED','SUCCESS']);

  // 5. They play a sponsored attempt. Opponents move, every answer is paid for through the ledger.
  await store.call('grantFunding',{amountNanousd:500_000_000,authorizationRef:'journey-grant-1',grantedBy:'test',now});
  const sponsored=await json<ChallengeAttemptView>('/attempts',player,{requestId:'start-sponsored',challengeId:card.id,challengeVersion:card.version,mode:'SPONSORED'});
  assert.deepEqual([sponsored.mode,sponsored.challenge.opponentLabel],['SPONSORED','GPT-6 Luna opponents · sponsored']);
  const afterTurn=(await turn(player,sponsored.id,['SMY|MOVE|ARM','CON|MOVE|SMY','ANK|MOVE|CON'])).view;
  assert.deepEqual([afterTurn.board.season,afterTurn.execution,afterTurn.notice],['FALL','ACCEPTING',null]);
  assert.equal(lunaBodies.length,6);
  // None of the six requests carried the player's submitted moves.
  for(const body of lunaBodies)for(const move of ['SMY moves to ARM','CON moves to SMY','ANK moves to CON'])assert.ok(!body.includes(move),move);
  const sponsoredReports=(await json<{reports:PublicPhaseReport[]}>(`/attempts/${sponsored.id}/reports`,player)).reports;
  assert.ok(sponsoredReports[0].phase==='ORDERS'&&sponsoredReports[0].resolvedOrders.some(o=>o.power!=='TURKEY'&&o.type!=='HOLD'));
  const funded=await store.call('fundingTotals',{});
  assert.ok(funded.settledNanousd>0);assert.equal(funded.reservedNanousd+funded.unknownLiabilityNanousd,0);

  // 6. The owner signs in and oversees: totals match the ledger, the spectator view matches the player's reports.
  const owner=await signIn(OWNER_ID);
  assert.equal((await json<PlayerSession>('/auth/session',owner)).operator,true);
  assert.equal((await call('/operator/overview',player)).status,403);
  const overview=await json<OperatorOverview>('/operator/overview',owner);
  assert.deepEqual([overview.activeAttempts,overview.funding.settledNanousd,overview.spend.calls],[1,funded.settledNanousd,6]);
  assert.deepEqual(overview.attempts.map(a=>[a.mode,a.lifecycle]).sort(),[['PRACTICE','COMPLETED'],['SPONSORED','ACTIVE']]);
  assert.deepEqual(overview.outbox.recent.map(m=>m.kind),['ATTEMPT_STARTED','ATTEMPT_STARTED']);
  const watched=await json<OperatorAttemptDetail>(`/operator/attempts/${sponsored.id}`,owner);
  assert.deepEqual(watched.reports,sponsoredReports);assert.equal(watched.funding.settledNanousd,funded.settledNanousd);
  const overviewText=JSON.stringify(overview)+JSON.stringify(watched);
  for(const secret of ['private@example.test','never-stored','user-555001','"subject"','journey-secret'])assert.ok(!overviewText.includes(secret),secret);
  assert.equal(await operator.notifier.drain(),2);

  // 7. The owner pauses paid play. The attempt waits with orders saved; a second player is told and asks once for more.
  assert.equal((await call('/operator/paid',owner,{stopped:true})).status,200);
  const view=await json<ChallengeAttemptView>(`/attempts/${sponsored.id}`,player),legal=await json<ChallengeLegalCatalog>(`/attempts/${sponsored.id}/legal`,player);
  const held={revision:view.revision,phaseId:view.phaseId,requestId:'while-paused',action:{phase:'ORDERS',orderIds:[...new Set(legal.options.map(o=>o.unitTerritory))].map(u=>legal.options.find(o=>o.unitTerritory===u&&o.order.type==='HOLD')!.id)}};
  assert.equal((await call(`/attempts/${sponsored.id}/orders`,player,held)).status,200);await service.attempts.wait(sponsored.id);
  const waiting=await json<ChallengeAttemptView>(`/attempts/${sponsored.id}`,player);
  assert.deepEqual([waiting.execution,waiting.notice,waiting.board.season],['RECOVERING','SPONSORED_PAUSED','FALL']);
  assert.equal(lunaBodies.length,6);
  assert.equal((await json<ChallengeCatalog>('/challenges')).sponsoredPlay,'PAUSED');
  const second=await signIn(555002),refused=await call('/attempts',second,{requestId:'s',challengeId:card.id,challengeVersion:card.version,mode:'SPONSORED'});
  assert.deepEqual([refused.status,(await refused.json()).code],[409,'SPONSORED_UNAVAILABLE']);
  assert.deepEqual(await json('/credit-request',second,{}),{recorded:true,duplicate:false});
  assert.deepEqual(await json('/credit-request',second,{}),{recorded:true,duplicate:true});
  // Resumed: the waiting attempt continues from the saved orders and the phase resolves once.
  assert.equal((await call('/operator/paid',owner,{stopped:false})).status,200);
  assert.equal((await call(`/attempts/${sponsored.id}/recover`,player,{})).status,200);await service.attempts.wait(sponsored.id);
  const resumed=await json<ChallengeAttemptView>(`/attempts/${sponsored.id}`,player);
  assert.deepEqual([resumed.execution,resumed.notice],['ACCEPTING',null]);assert.notEqual(resumed.phaseId,waiting.phaseId);
  // The waiting phase resolved exactly once. A following phase that asks nothing of the player may have run as well.
  const resumedReports=(await json<{reports:PublicPhaseReport[]}>(`/attempts/${sponsored.id}/reports`,player)).reports;
  assert.ok(resumedReports.length>=2);assert.equal(new Set(resumedReports.map(r=>r.id)).size,resumedReports.length);

  // 8. The player deletes their account. Their data is gone; what was spent is still on the books.
  const spent=(await store.call('fundingTotals',{})).settledNanousd;
  assert.equal((await call('/account/delete',player,{confirm:'DELETE'})).status,200);
  assert.equal((await call('/attempts',player)).status,401);
  assert.equal(await store.call('attempt',{id:practice.id}),null);assert.equal(await store.call('attempt',{id:sponsored.id}),null);
  assert.equal((await store.call('fundingTotals',{})).settledNanousd,spent);
  const final=await json<OperatorOverview>('/operator/overview',owner);
  assert.deepEqual([final.attempts.length,final.funding.settledNanousd,final.activeAttempts],[0,spent,0]);
  assert.deepEqual(final.outbox.recent.map(m=>m.kind).sort(),['ATTEMPT_STARTED','ATTEMPT_STARTED','CREDIT_REQUEST']);

  // 9. The owner signs out; the operator view closes with the session.
  assert.equal((await call('/auth/logout',owner,{})).status,204);
  assert.equal((await call('/operator/overview',owner)).status,401);
});
