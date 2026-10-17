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
    lastYear: 1901, effort: 'medium', transport: 'mock', talkRecipients: 2 });
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
