import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_POWERS, type Power } from '@diplomacy/shared';
import { autoplay, type ModelKey } from '../autoplay/Autoplay.js';
import { mockOpponentTransport, type LunaTransport } from '../luna/Transport.js';
import { OPPONENT_CONTRACTS, opponentContract } from '../providers/OpponentContract.js';
import { mixedPlan } from '../providers/OpponentPlan.js';
import { Store } from '../storage/Store.js';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';

test.after(() => shutdownGodip());

test('GPT Sol 6.1 and Claude Sonnet 5.5 have their own pinned requests, prices and reservations',() => {
  const sol = opponentContract('sol'), sonnet = opponentContract('sonnet');
  assert.deepEqual([sol.preset.provider,sol.preset.model,sonnet.preset.provider,sonnet.preset.model],['OPENAI','gpt-6.1-sol','ANTHROPIC','claude-sonnet-5-5']);
  for (const [contract, other] of [[sol,OPPONENT_CONTRACTS.luna],[sonnet,OPPONENT_CONTRACTS.haiku]] as const) {
    const body = JSON.parse(contract.buildFullGameRequest({ context: 'x' },'UNIT_ORDERS').body), same = JSON.parse(other.buildFullGameRequest({ context: 'x' },'UNIT_ORDERS').body);
    // The same request as the smaller model of its provider, apart from the model name.
    assert.equal(body.model,contract.preset.model); assert.deepEqual({ ...body, model: null },{ ...same, model: null });
    assert.notEqual(contract.presetHash,other.presetHash); assert.notEqual(contract.preset.pricingVersion,other.preset.pricingVersion);
  }
  // Worst case: every allowed input token at the dearest input rate, plus the whole output ceiling at $10 per million.
  assert.equal(sol.reservationNanousd(32_768),32_768 * 2_500 + 2_048 * 10_000);
  assert.equal(sonnet.reservationNanousd(32_768),32_768 * 4_000 + 4_096 * 10_000);
  assert.equal(sonnet.reservationNanousd(32_768,16_384),32_768 * 4_000 + 16_384 * 10_000);
  // Billing at their own rates: $2 per million input, $10 per million output.
  const solBill = sol.normalizeResponse(sol.mockEnvelope({ serial: 1, text: '{"choices":[]}', inputTokens: 1_000, outputTokens: 100 }),200);
  assert.deepEqual([solBill.status,solBill.usage?.costNanousd],['COMPLETED',1_000 * 2_000 + 100 * 10_000]);
  const sonnetBill = sonnet.normalizeResponse(sonnet.mockEnvelope({ serial: 1, text: '{"choices":[]}', inputTokens: 1_000, outputTokens: 100 }),200);
  assert.deepEqual([sonnetBill.status,sonnetBill.usage?.costNanousd],['COMPLETED',1_000 * 2_000 + 100 * 10_000]);
  // An answer from another model is never priced at these rates.
  assert.equal(sol.normalizeResponse(OPPONENT_CONTRACTS.luna.mockEnvelope({ serial: 1, text: '{}', inputTokens: 10, outputTokens: 10 }),200).status,'ERROR');
  assert.equal(sonnet.normalizeResponse(OPPONENT_CONTRACTS.haiku.mockEnvelope({ serial: 1, text: '{}', inputTokens: 10, outputTokens: 10 }),200).status,'ERROR');
  // A mix including them is its own plan.
  assert.notEqual(mixedPlan({ ENGLAND: 'sonnet' },OPPONENT_CONTRACTS.sol).id,mixedPlan({ ENGLAND: 'haiku' },OPPONENT_CONTRACTS.luna).id);
});

test('a full game with Sonnet and Sol plays through the ledger with every call recorded under its own model',async t => {
  const dir = await mkdtemp(join(tmpdir(),'diplomacy-strong-')), store = await Store.open(join(dir,'game.sqlite'));
  t.after(async () => { await store.close(); await rm(dir,{ recursive: true, force: true }); });
  await store.call('grantFunding',{ amountNanousd: 5_000_000_000, authorizationRef: 'owner-strong-0001', grantedBy: 'test', now: 1 });
  await store.call('setFundingPolicy',{ attemptCapNanousd: 5_000_000_000, ceilingLimitNanousd: null, now: 1 });
  const assignment = Object.fromEntries(ALL_POWERS.map((p,i) => [p, i % 2 ? 'sonnet' : 'sol'])) as Record<Power, ModelKey>;
  const transports = Object.fromEntries((['sol','sonnet'] as const).map(key => [key,mockOpponentTransport(opponentContract(key),{ pick: 'seeded', seed: 2 })])) as Record<ModelKey, LunaTransport>;
  const result = await autoplay({ store, runId: 'strong-a', lastYear: 1901, assignment, transports, transportKind: 'mock', now: () => 1_800_000_000_000 });
  assert.equal(result.status,'FINISHED');
  assert.deepEqual(new Set(Object.values(result.run.assignment)),new Set(['gpt-6.1-sol','claude-sonnet-5-5']));
  const calls = await store.call('providerCallsForAttempt',{ attemptId: result.run.attemptId });
  assert.ok(calls.length > 0 && calls.every(c => c.model === (assignment[c.power] === 'sol' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5') && c.usage));
  assert.ok(result.summary.settledNanousd > 0);
});
