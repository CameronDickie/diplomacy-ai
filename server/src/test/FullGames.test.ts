import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FullGameService } from '../autoplay/FullGameService.js';
import { Store } from '../storage/Store.js';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';

test.after(() => shutdownGodip());

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(),'diplomacy-fullgames-')), path = join(dir,'autoplay.sqlite');
  const store = await Store.open(path);
  await store.call('grantFunding',{ amountNanousd: 5_000_000_000, authorizationRef: 'owner-games-0001', grantedBy: 'test', now: 1 });
  await store.call('setFundingPolicy',{ attemptCapNanousd: 5_000_000_000, ceilingLimitNanousd: null, now: 1 });
  await store.close();
  const service = new FullGameService(path,join(dir,'stand-in.sqlite'));
  t.after(async () => { await service.close(); await rm(dir,{ recursive: true, force: true }); });
  const settle = async () => { for (let i = 0; i < 600 && (await service.list()).running; i++) await new Promise(r => setTimeout(r,50)); };
  return { service, settle };
}

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
  await service.start({ runId: 'seat-a', until: 1901, seat: 'FRANCE' });
  // Spring 1901: the models have written first; the game waits for the person's messages.
  const asked = await wait('TALK');
  assert.equal(asked.settings.seat,'FRANCE'); assert.equal(asked.run.assignment.FRANCE,'human');
  // Legal orders are available while the person writes, so they can plan.
  assert.ok((await service.legal('seat-a')).options.some(o => o.unitTerritory === 'PAR'));
  await assert.rejects(service.act('seat-a',{ phase: 'ORDERS', orderIds: [] }),/not waiting for your orders/);
  assert.throws(() => service.talk('seat-a',[{ to: 'FRANCE', body: 'myself' }]),/another power/);
  service.talk('seat-a',[{ to: 'ENGLAND', body: 'Stay out of the Channel and I will stay out of Belgium.' }]);
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
  assert.equal((await service.game('seat-a'))!.live.status,'PAUSED');
  await service.start({ runId: 'seat-a', until: 1901, seat: 'FRANCE' });
  const again = await wait('ACT');
  assert.equal(again.record.phases.find(p => p.phaseId === again.live.waitingFor!.phaseId)!.talk!.filter(c => c.power === 'FRANCE').length,1);
  // Every later phase waits for the person too, until the game ends.
  for (let i = 0; i < 20 && (await service.list()).running; i++) {
    const game = await service.game('seat-a');
    if (game?.live.waitingFor?.kind === 'TALK') service.talk('seat-a',[]);
    else if (game?.live.waitingFor?.kind === 'ACT') await service.act('seat-a',await scriptedHumanAction(rules,game.current,'FRANCE',{ witnesses: [] } as never,''));
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
});
