import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FullGameService, fullGamesEnabled } from '../autoplay/FullGameService.js';
import { Store } from '../storage/Store.js';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';

test.after(() => shutdownGodip());

test('full-game controls are enabled only on nonproduction loopback local servers',() => {
  for (const host of ['127.0.0.1','localhost','::1']) assert.equal(fullGamesEnabled({ profile: 'local', production: false, host }),true);
  for (const host of ['0.0.0.0','::','192.168.1.10']) assert.equal(fullGamesEnabled({ profile: 'local', production: false, host }),false);
  for (const profile of ['showcase','private'] as const) assert.equal(fullGamesEnabled({ profile, production: false, host: '127.0.0.1' }),false);
  assert.equal(fullGamesEnabled({ profile: 'local', production: true, host: '127.0.0.1' }),false);
});

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(),'diplomacy-fullgames-')), path = join(dir,'autoplay.sqlite');
  const store = await Store.open(path);
  await store.call('grantFunding',{ amountNanousd: 5_000_000_000, authorizationRef: 'owner-games-0001', grantedBy: 'test', now: 1 });
  await store.call('setFundingPolicy',{ attemptCapNanousd: 5_000_000_000, ceilingLimitNanousd: null, now: 1 });
  await store.close();
  const service = new FullGameService(path,join(dir,'stand-in.sqlite'));
  t.after(async () => { await service.close(); await rm(dir,{ recursive: true, force: true }); });
  const settle = async () => { for (let i = 0; i < 600 && (await service.list()).running; i++) await new Promise(r => setTimeout(r,50)); };
  return { service, settle, path, standInPath: join(dir,'stand-in.sqlite') };
}

test('simultaneous starts admit one game, and invalid starts release the admission lock',async t => {
  const { service, settle } = await setup(t);
  await assert.rejects(service.start({ runId: 'invalid', until: 1901, orderCalls: 0 }),/orders calls/);
  const results = await Promise.allSettled([
    service.start({ runId: 'concurrent-a', until: 1901 }),
    service.start({ runId: 'concurrent-b', until: 1901 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length,1);
  assert.equal(results.filter(result => result.status === 'rejected').length,1);
  await settle();
  assert.equal((await service.list()).games.length,1);
});

test('human orders survive a server restart and cannot be replaced by another submission',async t => {
  const { service, path, standInPath } = await setup(t);
  const { scriptedHumanAction } = await import('../evaluation/ScriptedPlayer.js');
  const { PhaseRules } = await import('../attempts/PhaseRules.js');
  const wait = async (instance: FullGameService) => {
    for (let tries = 0; tries < 400; tries++) {
      const game = await instance.game('durable-seat');
      if (game?.live.waitingFor) return game;
      await new Promise(resolve => setTimeout(resolve,25));
    }
    throw new Error('Never waited for the human seat.');
  };
  await service.start({ runId: 'durable-seat', until: 1901, seat: 'FRANCE', messages: 0 });
  const first = await wait(service);
  assert.equal(first.live.waitingFor!.kind,'ACT');
  const action = await scriptedHumanAction(new PhaseRules(),first.current,'FRANCE',{ witnesses: [] } as never,'');
  const store = await Store.open(standInPath);
  const job = (await store.call('pendingPhaseJobs',{})).find(job => job.attemptId === 'auto-durable-seat')!;
  const input = { attemptId: job.attemptId, operationId: job.operationId, phaseId: job.phaseId, power: 'FRANCE' as const, action, now: Date.now() };
  await assert.rejects(store.call('saveHumanAction',{ ...input, power: 'ENGLAND' }),/no longer waiting/);
  await store.call('saveHumanAction',input);
  await store.call('saveHumanAction',input);
  await assert.rejects(store.call('saveHumanAction',{ ...input, action: { phase: 'ORDERS', orderIds: [] } }),/already submitted/);
  await store.close();
  await service.close();
  const reopened = new FullGameService(path,standInPath);
  t.after(() => reopened.close());
  await reopened.start({ runId: 'durable-seat', until: 1901, seat: 'FRANCE', messages: 0 });
  const next = await wait(reopened);
  assert.notEqual(next.live.waitingFor!.phaseId,first.live.waitingFor!.phaseId);
  const report = next.record.phases.find(phase => phase.phaseId === first.live.waitingFor!.phaseId)!.report!;
  assert.equal(report.phase,'ORDERS');
  if (report.phase === 'ORDERS') assert.ok(report.resolvedOrders.filter(order => order.power === 'FRANCE').every(order => order.type === 'HOLD'));
});

test('a game started from the page plays in the background, and its record and settings are read back from the database',async t => {
  const { service, settle } = await setup(t);
  assert.deepEqual((await service.list()).games,[]);
  await service.start({ runId: 'page-a', until: 1901, assignment: { ENGLAND: 'luna' }, effort: 'medium', messages: 2 });
  // One game at a time.
  await assert.rejects(service.start({ runId: 'page-b', until: 1901 }),/still being played/);
  // Until its first phase is created the game is not in the database yet; once it is, its page says it is running.
  const during = await service.game('page-a');
  assert.ok(during === null || ['RUNNING','FINISHED'].includes(during.live.status));
  await settle();
  const game = (await service.game('page-a'))!;
  assert.equal(game.live.status,'FINISHED'); assert.equal(game.status,'FINISHED'); assert.equal(game.endedBy,'LAST_YEAR');
  assert.deepEqual(game.settings,{ assignment: { AUSTRIA: 'luna', ENGLAND: 'luna', FRANCE: 'luna', GERMANY: 'haiku', ITALY: 'luna', RUSSIA: 'haiku', TURKEY: 'luna' },
    lastYear: 1901, effort: 'medium', transport: 'mock', talkRecipients: 2, seat: null });
  assert.equal(game.run.assignment.ENGLAND,'gpt-6-luna');
  assert.ok(game.record.phases.filter(p => p.report).length >= 2 && game.live.log.some(l => /Started with stand-in models/.test(l)));
  const listed = (await service.list()).games;
  assert.deepEqual(listed.map(g => [g.runId,g.lifecycle,g.running,g.standIn]),[['page-a','COMPLETED',false,true]]);
  // Stand-in games never touch the real ledger.
  assert.equal((await service.list()).funding.settledNanousd,0); assert.equal(game.standIn,true);
  assert.equal(await service.game('missing'),null);
});

test('a same-phase retry during human validation accepts the checked orders instead of rejecting them as stale',async t => {
  const { service } = await setup(t);
  await service.start({ runId: 'validation-retry', until: 1901, seat: 'FRANCE', messages: 0 });
  let phaseId: string | undefined;
  for (let tries = 0; tries < 400; tries++) {
    phaseId = (await service.game('validation-retry'))?.live.waitingFor?.phaseId;
    if (phaseId) break;
    await new Promise(resolve => setTimeout(resolve,25));
  }
  assert.ok(phaseId);
  const rules = service['rules'], validate = rules.validate.bind(rules);
  let replaced = false;
  rules.validate = async (...args) => {
    await validate(...args);
    const run = service['running']!.run;
    assert.equal(run.pending?.phaseId,phaseId);
    run.pending = { ...run.pending! };
    replaced = true;
  };
  await service.act('validation-retry',{ phase: 'ORDERS', orderIds: ['PAR|HOLD','BRE|HOLD','MAR|HOLD'] },phaseId);
  assert.equal(replaced,true);
});

test('human message acknowledgement waits for durable storage',async t => {
  const { service } = await setup(t);
  await service.start({ runId: 'durable-talk', until: 1901, seat: 'FRANCE' });
  for (let tries = 0; tries < 400 && service['running']?.run.pending?.kind !== 'TALK'; tries++) await new Promise(resolve => setTimeout(resolve,25));
  const pending = service['running']!.run.pending!;
  assert.equal(pending.kind,'TALK');
  const store = await service['open']('standIn'), call = store.call.bind(store);
  let release!: () => void, saving!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { saving = resolve; });
  store.call = (operation,input) => {
    if (operation === 'saveHumanTalk') { saving(); return held.then(() => call(operation,input)); }
    return call(operation,input);
  };
  let acknowledged = false;
  const submitted = service.talk('durable-talk',[{ to: 'ENGLAND', body: 'An alliance?' }],pending.phaseId).then(() => { acknowledged = true; });
  await entered;
  assert.equal(acknowledged,false);
  assert.equal(service['running']!.run.pending,pending);
  release();
  await submitted;
  store.call = call;
  const written = (await store.call('powerTalks',{ attemptId: 'auto-durable-talk' })).find(talk => talk.power === 'FRANCE');
  assert.deepEqual(written!.messages,[{ to: 'ENGLAND', body: 'An alliance?' }]);
});

test('a running game stops after the phase in hand and continues where it stopped; bad requests are refused before anything runs',async t => {
  const { service, settle } = await setup(t);
  await service.start({ runId: 'page-c', until: 1950 });
  for (let i = 0; i < 200 && !(await service.game('page-c'))?.record.phases.some(p => p.report); i++) await new Promise(r => setTimeout(r,25));
  assert.equal(service.stop('page-c'),true); assert.equal(service.stop('other'),false);
  await settle();
  const stopped = (await service.game('page-c'))!;
  assert.equal(stopped.live.status,'PAUSED'); assert.match(stopped.live.waitingOn!,/Stopped by you/);
  const played = stopped.record.phases.filter(p => p.report).length;
  await service.start({ runId: 'page-c', until: 1950 });
  for (let i = 0; i < 400 && (await service.game('page-c'))!.record.phases.filter(p => p.report).length <= played; i++) await new Promise(r => setTimeout(r,25));
  service.stop('page-c'); await settle();
  assert.ok((await service.game('page-c'))!.record.phases.filter(p => p.report).length > played);
  // A continued game keeps its settings: another last year is refused by the game itself, and shown on its page.
  await service.start({ runId: 'page-c', until: 1960 }); await settle();
  assert.match((await service.game('page-c'))!.live.error!,/different last year/);
  await assert.rejects(service.start({ runId: 'Bad Name', until: 1901 }),/game name/);
  await assert.rejects(service.start({ runId: 'page-d', until: 1800 }),/last year/);
  await assert.rejects(service.start({ runId: 'page-d', until: 1901, assignment: { FRANCE: 'gemini' as never } }),/Unknown model/);
  await assert.rejects(service.start({ runId: 'page-d', until: 1901, effort: 'extreme' as never }),/effort/);
  // A paid game needs a recorded grant and the provider's key.
  await assert.rejects(service.start({ runId: 'page-d', until: 1901, live: true }),/authorization-ref|grant/);
  await assert.rejects(service.start({ runId: 'page-d', until: 1901, live: true, authorizationRef: 'owner-missing-0001' }),/grant|key/);
  // A stand-in game cannot be continued with live models.
  await assert.rejects(service.start({ runId: 'page-c', until: 1950, live: true, authorizationRef: 'owner-games-0001' }),/stand-in game/);
});

test('a person can hold one seat: the game waits for their messages and their orders, and the models answer them',async t => {
  const { service, settle } = await setup(t);
  const { scriptedHumanAction } = await import('../evaluation/ScriptedPlayer.js');
  const { PhaseRules } = await import('../attempts/PhaseRules.js');
  const rules = new PhaseRules(), wait = async (kind: 'TALK' | 'ACT') => {
    for (let i = 0; i < 400; i++) { const g = await service.game('seat-a'); if (g?.live.waitingFor?.kind === kind) return g; await new Promise(r => setTimeout(r,25)); }
    throw new Error(`never asked for ${kind}`);
  };
  // The seat's own model choice never plays, but it is part of the run's plan; continuing must still match it.
  await service.start({ runId: 'seat-a', until: 1901, seat: 'FRANCE', assignment: { FRANCE: 'sonnet' } });
  // Spring 1901: the models have written first; the game waits for the person's messages.
  const asked = await wait('TALK');
  assert.equal(asked.settings.seat,'FRANCE'); assert.equal(asked.run.assignment.FRANCE,'human');
  // The list marks the game as one a person plays, so the Games home can show it as theirs.
  assert.equal((await service.list()).games.find(g => g.runId === 'seat-a')!.seat,'FRANCE');
  // Legal orders are available while the person writes, so they can plan.
  assert.ok((await service.legal('seat-a')).options.some(o => o.unitTerritory === 'PAR'));
  await assert.rejects(service.act('seat-a',{ phase: 'ORDERS', orderIds: [] }),/not waiting for your orders/);
  await assert.rejects(service.talk('seat-a',[{ to: 'FRANCE', body: 'myself' }]),/another power/);
  await assert.rejects(service.talk('seat-a',[],'stale-phase'),/phase has changed/);
  await service.talk('seat-a',[{ to: 'ENGLAND', body: 'Stay out of the Channel and I will stay out of Belgium.' }],asked.live.waitingFor!.phaseId);
  // Then the models reply (England to France among them) and the game waits for orders.
  const ordering = await wait('ACT');
  const spring = ordering.record.phases.find(p => p.phaseId === ordering.live.waitingFor!.phaseId)!;
  assert.ok(spring.talk!.some(c => c.power === 'FRANCE' && c.model === 'human' && c.messages[0].to === 'ENGLAND'));
  assert.ok(spring.talk!.some(c => c.power === 'ENGLAND' && c.round === 'REPLY' && c.messages.some(m => m.to === 'FRANCE')));
  const legal = await service.legal('seat-a');
  assert.ok(legal.options.length > 0 && legal.options.every(o => ['BRE','MAR','PAR'].includes(o.unitTerritory)));
  await assert.rejects(service.act('seat-a',{ phase: 'ORDERS', orderIds: ['PAR|MOVE|MUN'] }),/not legal/);
  // Stopping while the game waits for the person stops it at once; continuing asks only for what is still missing.
  assert.equal(service.stop('seat-a'),true); await settle();
  const paused = (await service.game('seat-a'))!;
  assert.equal(paused.live.status,'PAUSED'); assert.equal(paused.settings.assignment.FRANCE,'sonnet');
  // Continue as the page does: with the settings read back from the game.
  await service.start({ runId: 'seat-a', until: 1901, seat: 'FRANCE', assignment: paused.settings.assignment });
  const again = await wait('ACT');
  assert.equal(again.record.phases.find(p => p.phaseId === again.live.waitingFor!.phaseId)!.talk!.filter(c => c.power === 'FRANCE').length,1);
  // Every later phase waits for the person too, until the game ends. A phase is played again whenever a
  // model's answer is refused (the stand-ins' are, in Fall 1901); orders already given stand, so the person
  // is never asked twice for the same phase's orders.
  const answered = new Set<string>();
  for (let i = 0; i < 20 && (await service.list()).running; i++) {
    const game = await service.game('seat-a'), waiting = game?.live.waitingFor;
    if (waiting?.kind === 'TALK') await service.talk('seat-a',[],waiting.phaseId);
    else if (waiting?.kind === 'ACT') {
      assert.ok(!answered.has(waiting.phaseId),`asked again for ${waiting.phaseId} after its orders were given`);
      await service.act('seat-a',await scriptedHumanAction(rules,game!.current,'FRANCE',{ witnesses: [] } as never,''),waiting.phaseId);
      answered.add(waiting.phaseId);
    }
    else await new Promise(r => setTimeout(r,50));
  }
  await settle();
  const done = (await service.game('seat-a'))!;
  assert.equal(done.status,'FINISHED');
  // The person's orders were played: France's units held in Spring 1901.
  const report = done.record.phases.find(p => p.report?.phase === 'ORDERS')!.report as unknown as { resolvedOrders: Array<{ power: string; type: string }> };
  assert.ok(report.resolvedOrders.filter(o => o.power === 'FRANCE').every(o => o.type === 'HOLD'));
  // Model-only games are untouched: no seat, every power a model.
  await service.start({ runId: 'plain-a', until: 1901 }); await settle();
  assert.equal((await service.game('plain-a'))!.settings.seat,null);
  assert.equal((await service.list()).games.find(g => g.runId === 'plain-a')!.seat,null);
});
