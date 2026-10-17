import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoplay, type ModelKey } from '../autoplay/Autoplay.js';
import { mockOpponentTransport, type LunaTransport } from '../luna/Transport.js';
import { opponentContract } from '../providers/OpponentContract.js';
import { Store } from '../storage/Store.js';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';

test.after(() => shutdownGodip());

test('a provider with its own budget stops paid play when that budget runs out, though the pool and the other provider still have money',async t => {
  const dir = await mkdtemp(join(tmpdir(),'diplomacy-budgets-')), store = await Store.open(join(dir,'game.sqlite'));
  t.after(async () => { await store.close(); await rm(dir,{ recursive: true, force: true }); });
  // Before any provider grant, nobody has a budget of its own.
  await store.call('grantFunding',{ amountNanousd: 5_000_000_000, authorizationRef: 'owner-pool-0001', grantedBy: 'test', now: 1 });
  assert.deepEqual((await store.call('fundingTotals',{})).providers,{ OPENAI: null, ANTHROPIC: null });
  await store.call('setFundingPolicy',{ attemptCapNanousd: 15_000_000_000, ceilingLimitNanousd: null, now: 1 });
  // Just over one phase's worth of worst-case Haiku calls for Anthropic; plenty for OpenAI.
  await store.call('grantFunding',{ amountNanousd: 55_000_000, authorizationRef: 'owner-anthropic-0001', grantedBy: 'test', now: 2, provider: 'ANTHROPIC' });
  await store.call('grantFunding',{ amountNanousd: 5_000_000_000, authorizationRef: 'owner-openai-0001', grantedBy: 'test', now: 2, provider: 'OPENAI' });
  // A reference names one amount and one provider.
  await assert.rejects(store.call('grantFunding',{ amountNanousd: 55_000_000, authorizationRef: 'owner-anthropic-0001', grantedBy: 'test', now: 3, provider: 'OPENAI' }),/different amount or provider/);
  await assert.rejects(store.call('grantFunding',{ amountNanousd: 1, authorizationRef: 'owner-bad-0001', grantedBy: 'test', now: 3, provider: 'GEMINI' as never }),/Invalid funding/);
  const start = await store.call('fundingTotals',{});
  assert.deepEqual([start.providers.ANTHROPIC?.grantedNanousd,start.providers.OPENAI?.grantedNanousd,start.grantedNanousd],[55_000_000,5_000_000_000,10_055_000_000]);

  const transports = Object.fromEntries((['luna','haiku'] as const).map(key => [key,mockOpponentTransport(opponentContract(key),{ pick: 'seeded', seed: 4 })])) as Record<ModelKey, LunaTransport>;
  const result = await autoplay({ store, runId: 'budget-a', lastYear: 1910, transports, transportKind: 'mock', now: () => 10 });
  assert.equal(result.status,'WAITING'); assert.match(result.waitingOn!,/a budget is used up/);
  const after = await store.call('fundingTotals',{}), anthropic = after.providers.ANTHROPIC!, openai = after.providers.OPENAI!;
  // Anthropic could not fit one more worst-case Haiku call; OpenAI and the pool had plenty.
  const haikuWorst = opponentContract('haiku').reservationNanousd(opponentContract('haiku').preset.maxInputTokens);
  assert.ok(anthropic.availableNanousd < haikuWorst, `${anthropic.availableNanousd}`);
  assert.ok(openai.availableNanousd > 4_000_000_000 && after.availableNanousd > 4_000_000_000);
  assert.ok(anthropic.settledNanousd > 0 && openai.settledNanousd > 0);
  assert.equal((await store.call('paidState',{})).stopped,true);
  // Every Haiku call is charged to Anthropic's budget, every Luna call to OpenAI's.
  const calls = await store.call('providerCallsForAttempt',{ attemptId: result.run.attemptId });
  const spent = (model: string) => calls.filter(c => c.model === model).reduce((n,c) => n + (c.usage?.costNanousd ?? 0),0);
  assert.equal(anthropic.settledNanousd,spent('claude-haiku-5-5')); assert.equal(openai.settledNanousd,spent('gpt-6-luna'));
  // A game cannot start while a provider it needs cannot pay for a phase.
  await assert.rejects(autoplay({ store, runId: 'budget-b', lastYear: 1901, transports, transportKind: 'mock', now: () => 20 }),/paused|Anthropic budget/);
});
