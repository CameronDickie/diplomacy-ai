import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_POWERS, type Power } from '@diplomacy/shared';
import { DEFAULT_ASSIGNMENT, autoplay, fullGameDefinition, type ModelKey } from '../autoplay/Autoplay.js';
import { assertDevelopment, parseAssignment } from '../autoplay/cli.js';
import { parseMessages, talkLines, type PowerMessage } from '../luna/Context.js';
import { parseUnitOrders } from '../luna/Choices.js';
import { PreflightError, mockOpponentTransport, type LunaTransport } from '../luna/Transport.js';
import { OPPONENT_CONTRACTS, opponentContract } from '../providers/OpponentContract.js';
import { parseChallenge } from '../storage/publicData.js';
import { Store } from '../storage/Store.js';
import { TUNIS_PILOT_V1, scoreChallenge } from '../challenge/TunisPilot.js';

async function setup(t: test.TestContext, granted = 5_000_000_000) {
  const dir = await mkdtemp(join(tmpdir(),'diplomacy-autoplay-')), store = await Store.open(join(dir,'game.sqlite'));
  await store.call('grantFunding',{ amountNanousd: granted, authorizationRef: 'owner-auto-0001', grantedBy: 'test', now: 1 });
  await store.call('setFundingPolicy',{ attemptCapNanousd: 5_000_000_000, ceilingLimitNanousd: null, now: 1 });
  t.after(async () => { await store.close(); await rm(dir,{ recursive: true, force: true }); });
  /** Stand-in models that also record every request each model was sent. */
  const sent: Array<{ key: ModelKey; context: string; kind: 'ORDERS' | 'UNIT_ORDERS' | 'ASK' | 'REPLY' }> = [];
  const transports = (wrap: (key: ModelKey, inner: LunaTransport) => LunaTransport = (_key,inner) => inner) => Object.fromEntries((['luna','haiku'] as const).map(key => {
    const contract = opponentContract(key), inner = mockOpponentTransport(contract,{ pick: 'seeded', seed: 3 });
    const recording: LunaTransport = async request => {
      const context = contract.contextOf(request.body);
      sent.push({ key, context, kind: (['ORDERS','UNIT_ORDERS','ASK','REPLY'] as const).find(kind => contract.buildFullGameRequest({ context },kind).body === request.body)! });
      return inner(request);
    };
    return [key,wrap(key,recording)];
  })) as Record<ModelKey, LunaTransport>;
  const run = (extra: Partial<Parameters<typeof autoplay>[0]> = {}) => autoplay({ store, runId: 'game-a', lastYear: 1902, transports: transports(), transportKind: 'mock', now: () => 1_800_000_000_000, ...extra });
  return { store, sent, transports, run };
}
const player = (_attemptId: string) => 'test-operator';
const speaker = (context: string) => /\nYou are ([A-Z]+)\./.exec(context)![1] as Power;

test('a full game with a model on every power plays to its last year through the ledger, with both models and messages between powers',async t => {
  const f = await setup(t), result = await f.run();
  assert.equal(result.status,'FINISHED'); assert.equal(result.waitingOn,null);
  assert.equal(result.record.attempt.lifecycle,'COMPLETED');
  assert.deepEqual([result.summary.year,result.summary.season],[1902,'WINTER']);
  // Seven supply-center counts that add up to what is owned on the board.
  assert.equal(Object.keys(result.summary.centers).length,7);
  assert.deepEqual(result.run.assignment,Object.fromEntries(ALL_POWERS.map(p => [p,OPPONENT_CONTRACTS[DEFAULT_ASSIGNMENT[p]].preset.model])));
  const orders = result.record.phases.filter(p => p.report?.phase === 'ORDERS');
  assert.equal(orders.length,4);
  for (const phase of orders) {
    // All seven powers were decided by a call, including the nominal seat that opens each phase.
    assert.deepEqual(phase.calls.map(c => c.power).sort(),[...ALL_POWERS].sort());
    assert.ok(phase.calls.every(c => c.outcome === 'VALID'));
    const austria = phase.calls.find(c => c.power === 'AUSTRIA')!.decision as { orderIds: string[] };
    assert.deepEqual(phase.report!.phase === 'ORDERS' ? phase.report!.resolvedOrders.filter(o => o.power === 'AUSTRIA').map(o => o.id).sort() : [],[...austria.orderIds].sort());
    // Each power wrote at most once and answered at most once, to at most three others.
    const asks = phase.talk!.filter(c => c.round === 'ASK'), replies = phase.talk!.filter(c => c.round === 'REPLY');
    assert.equal(asks.length,7); assert.ok(asks.every(c => c.messages.length >= 1 && c.messages.length <= 3 && c.messages.every(m => m.to !== c.power)));
    assert.equal(new Set(replies.map(c => c.power)).size,replies.length);
    for (const reply of replies) assert.deepEqual(reply.messages.map(m => m.to).sort(),asks.filter(a => a.messages.some(m => m.to === reply.power)).map(a => a.power).sort());
  }
  // Both models were used, each only for its own powers.
  for (const { key, context } of f.sent) assert.equal(DEFAULT_ASSIGNMENT[speaker(context)],key);
  assert.ok(result.record.models['gpt-6-luna'].calls > 0 && result.record.models['claude-haiku-5-5'].calls > 0);
  assert.equal(result.summary.messages,result.record.phases.flatMap(p => p.talk ?? []).reduce((n,c) => n + c.messages.length,0));
  // Every bill is on the ledger and nothing is left held.
  const funding = await f.store.call('attemptFunding',{ attemptId: result.run.attemptId }), totals = await f.store.call('fundingTotals',{});
  assert.equal(funding.heldNanousd,0); assert.equal(funding.settledNanousd,result.summary.settledNanousd); assert.equal(totals.settledNanousd,funding.settledNanousd);
  assert.equal(funding.settledNanousd,Object.values(result.record.models).reduce((n,m) => n + m.costNanousd + m.talkCostNanousd,0));
});

test('what powers said reaches their own later requests and nobody else\'s',async t => {
  const f = await setup(t); await f.run();
  const orders = f.sent.filter(s => s.kind === 'UNIT_ORDERS'), full = orders.filter(s => s.context.includes('Your private messages with other powers'));
  assert.ok(full.length > 0);
  // The full game is described as one: no human, no scenario objective.
  assert.ok(f.sent.every(s => s.context.includes('Full game: each of the seven powers is played separately') && !s.context.includes('played by a human')));
  for (const { context } of f.sent) {
    const me = speaker(context);
    // A request only ever shows messages this power sent or received.
    for (const line of context.split('\n').filter(l => /^\[[A-Z]+ \d{4}\] /.test(l))) assert.match(line,/^\[[A-Z]+ \d{4}\] (You to [A-Z]+|[A-Z]+ to you): /,`${me}: ${line}`);
  }
  // Orders are asked for unit by unit; retreats and builds remain a plain list of numbers.
  assert.ok(orders.every(s => s.context.includes('ORDERS phase') && /\nAnswer with \{"orders":\[\{"unit":"[A-Z]{3}","choice":\d+\}, \.\.\.\]\}: one entry for each heading above/.test(s.context)));
  assert.ok(f.sent.filter(s => s.kind === 'ORDERS').every(s => !s.context.includes('ORDERS phase') && s.context.includes('Answer with {"choices":[...]}')));
  // A reply request shows the message it answers; an opening request of the first turn has none to show.
  const firstAsk = f.sent.find(s => s.kind === 'ASK')!, firstReply = f.sent.find(s => s.kind === 'REPLY')!;
  assert.ok(!firstAsk.context.includes(' to you: ')); assert.match(firstAsk.context,/\nYou may write to up to 3 of: /);
  assert.ok(firstReply.context.includes(' to you: ')); assert.match(firstReply.context,/\nReply to: /);
});

test('continuing a run buys nothing twice, and a run cannot be continued with other models or another last year',async t => {
  const f = await setup(t), partial = await f.run({ maxPhases: 2 });
  assert.equal(partial.status,'PAUSED'); assert.match(partial.waitingOn!,/same run ID/);
  const afterPause = f.sent.length, done = await f.run();
  assert.equal(done.status,'FINISHED');
  const total = f.sent.length, again = await f.run();
  assert.equal(again.status,'FINISHED'); assert.equal(f.sent.length,total);
  assert.ok(afterPause < total);
  // No power was asked twice for the same thing in the same phase.
  const seen = new Set<string>();
  for (const phase of done.record.phases) {
    for (const call of phase.calls) { const key = `${phase.phaseId}:${call.power}:D`; assert.ok(!seen.has(key),key); seen.add(key); }
    for (const call of phase.talk ?? []) { const key = `${phase.phaseId}:${call.power}:${call.round}`; assert.ok(!seen.has(key),key); seen.add(key); }
  }
  await assert.rejects(f.run({ assignment: { ...DEFAULT_ASSIGNMENT, AUSTRIA: 'haiku' } }),/different models or prices/);
  await assert.rejects(f.run({ lastYear: 1903 }),/different last year/);
});

test('a message call that fails is tried again, then given up on for the turn, with every failure and its reason recorded; the game goes on',async t => {
  const f = await setup(t);
  // Germany's model answers every opening-message request with something unusable; Russia's fails only the first time each turn.
  const russiaSeen = new Set<string>();
  const transports = f.transports((key,inner) => async request => {
    const contract = opponentContract(key), context = contract.contextOf(request.body), me = speaker(context);
    const bad = () => ({ status: 200, body: contract.mockEnvelope({ serial: 9_000 + Math.floor(Math.random() * 1e9), text: 'not json', inputTokens: 100, outputTokens: 40 }) });
    if (contract.buildFullGameRequest({ context },'ASK').body === request.body) {
      if (me === 'GERMANY') return bad();
      if (me === 'RUSSIA' && !russiaSeen.has(request.body)) { russiaSeen.add(request.body); return bad(); }
    }
    return inner(request);
  });
  const lines: string[] = [], result = await f.run({ transports, log: line => lines.push(line) });
  assert.equal(result.status,'FINISHED'); assert.equal(result.endedBy,'LAST_YEAR');
  for (const phase of result.record.phases.filter(p => p.report?.phase === 'ORDERS')) {
    // Three tries (one call and two more), all recorded, no messages.
    const germany = phase.talk!.filter(c => c.power === 'GERMANY' && c.round === 'ASK');
    assert.deepEqual(germany.map(c => c.outcome),['INVALID_JSON','INVALID_JSON','INVALID_JSON']); assert.ok(germany.every(c => c.messages.length === 0));
    // One failure, then a usable answer: its messages were sent.
    const russia = phase.talk!.filter(c => c.power === 'RUSSIA' && c.round === 'ASK');
    assert.deepEqual(russia.map(c => c.outcome),['INVALID_JSON','VALID']); assert.ok(russia[1].messages.length >= 1);
    // Both still had their orders decided by their own model.
    for (const power of ['GERMANY','RUSSIA']) assert.equal(phase.calls.find(c => c.power === power)!.outcome,'VALID');
  }
  // Four orders phases: three recorded failures each for Germany (the last one final), one each for Russia.
  const failures = result.record.failures.map(x => x.reason);
  assert.equal(failures.filter(r => r.startsWith('GERMANY message call')).length,12);
  assert.equal(failures.filter(r => /^GERMANY message call, try 3: INVALID_JSON — gave up/.test(r)).length,4);
  assert.equal(failures.filter(r => /^RUSSIA message call, try 1: INVALID_JSON — trying again/.test(r)).length,4);
  assert.ok(lines.some(line => line.includes('! SPRING 1901 · GERMANY message call, try 1: INVALID_JSON')));
  // The failed calls were billed and are counted.
  assert.ok(result.record.models['claude-haiku-5-5'].talkCalls > result.record.models['claude-haiku-5-5'].talkValid);
  // With retries turned off, one try is all a power gets.
  const g = await setup(t), once = await g.run({ transports: g.transports((key,inner) => async request => {
    const contract = opponentContract(key), context = contract.contextOf(request.body);
    return speaker(context) === 'GERMANY' && contract.buildFullGameRequest({ context },'ASK').body === request.body
      ? { status: 200, body: contract.mockEnvelope({ serial: 9_000 + Math.floor(Math.random() * 1e9), text: 'not json', inputTokens: 100, outputTokens: 40 }) } : inner(request);
  }), messageRetries: 0, lastYear: 1901, runId: 'game-b' });
  assert.deepEqual(once.record.phases[0].talk!.filter(c => c.power === 'GERMANY' && c.round === 'ASK').map(c => c.outcome),['INVALID_JSON']);
});

test('a full game ends on a solo win or after its last year, and neither is scored as a failure',() => {
  const definition = fullGameDefinition(1903);
  const fall = (year: number) => ({ season: 'FALL', phase: 'ORDERS', year, sequence: year, dislodgedUnits: [], after: { territoryOwners: {} } }) as never;
  const score = (lifecycle: 'ACTIVE' | 'GAME_FINISHED', years: number[]) => scoreChallenge(definition,{ challengeId: definition.id, challengeVersion: 1, lifecycle, reports: years.map(fall) });
  assert.equal(score('ACTIVE',[1901,1902]).outcome,'INCOMPLETE');
  assert.deepEqual([score('ACTIVE',[1901,1902,1903]).outcome,score('ACTIVE',[1901,1902,1903]).reason],['SUCCESS','DEADLINE']);
  // The rules engine ends the game when a power owns 18 centers after a Fall; that is reported as the game finishing.
  assert.deepEqual([score('GAME_FINISHED',[1901,1902]).outcome,score('GAME_FINISHED',[1901,1902]).reason,score('GAME_FINISHED',[1901,1902]).completedYear],['SUCCESS','GAME_FINISHED',1902]);
});

test('running out of funds leaves the game waiting, with every decision already bought kept for the continuation',async t => {
  // The default recoveries are kept: on a loaded machine a rules-engine call can time out once, and that must not be mistaken for the funds running out.
  const f = await setup(t,60_000_000), result = await f.run({ lastYear: 1910 });
  assert.equal(result.status,'WAITING'); assert.match(result.waitingOn!,/funding grant is used up/);
  assert.equal(result.record.attempt.lifecycle,'ACTIVE');
  await f.store.call('grantFunding',{ amountNanousd: 5_000_000_000, authorizationRef: 'owner-auto-0002', grantedBy: 'test', now: 2 });
  const bought = (await f.store.call('providerCallsForAttempt',{ attemptId: result.run.attemptId })).filter(c => c.outcome === 'VALID').map(c => c.id);
  assert.ok(bought.length > 0);
  // A paused ledger is reported before anything is attempted, with what to do about it.
  await assert.rejects(f.run({ lastYear: 1910 }),/--resume-paid/);
  await f.store.call('setPaidStopped',{ stopped: false, operatorId: player(result.run.attemptId), now: 3 });
  const done = await f.run({ lastYear: 1910 });
  assert.equal(done.status,'FINISHED');
  const after = await f.store.call('providerCallsForAttempt',{ attemptId: result.run.attemptId });
  // Everything bought before the stop is still there, once.
  assert.ok(bought.every(id => after.filter(c => c.id === id).length === 1));
});

test('messages are read strictly and only a power\'s own are ever shown to it',() => {
  const allowed: Power[] = ['FRANCE','ITALY','RUSSIA'];
  assert.deepEqual(parseMessages({ messages: [{ to: 'france', text: '  Hello   there ' },{ to: 'TURKEY', text: 'not allowed' },{ to: 'FRANCE', text: 'again' },{ to: 'ITALY', text: '   ' },{ to: 'RUSSIA', text: 'x'.repeat(900) }] },allowed,3),
    [{ to: 'FRANCE', body: 'Hello there' },{ to: 'RUSSIA', body: 'x'.repeat(500) }]);
  assert.deepEqual(parseMessages({ messages: [{ to: 'FRANCE', text: 'a' },{ to: 'ITALY', text: 'b' },{ to: 'RUSSIA', text: 'c' }] },allowed,2).map(m => m.to),['FRANCE','ITALY']);
  assert.deepEqual(parseMessages({ messages: [] },allowed,3),[]);
  for (const bad of [null,[],{ messages: 'x' },{ messages: [], extra: 1 },{ messages: [{ to: 'FRANCE' }] },{ messages: [{ to: 1, text: 'a' }] },{ messages: Array.from({ length: 13 },() => ({ to: 'FRANCE', text: 'a' })) }])
    assert.throws(() => parseMessages(bad,allowed,3),/Expected/);
  const messages: PowerMessage[] = [{ when: 'SPRING 1901', from: 'FRANCE', to: 'ITALY', body: 'between others' },{ when: 'SPRING 1901', from: 'AUSTRIA', to: 'ITALY', body: 'mine,\nsent' },{ when: 'FALL 1901', from: 'RUSSIA', to: 'AUSTRIA', body: 'mine, received' }];
  assert.deepEqual(talkLines('AUSTRIA',messages),['[SPRING 1901] You to ITALY: mine, sent','[FALL 1901] RUSSIA to you: mine, received']);
  // A long history keeps its most recent messages.
  const long = Array.from({ length: 200 },(_,i): PowerMessage => ({ when: 'SPRING 1901', from: 'AUSTRIA', to: 'ITALY', body: `message ${i} ${'x'.repeat(100)}` }));
  const kept = talkLines('AUSTRIA',long);
  assert.ok(kept.length < 200 && kept.at(-1)!.includes('message 199 ') && Buffer.byteLength(kept.join('\n')) <= 6_000);
});

test('only a scenario marked as a model-only full game may list all seven powers, and the tool refuses to run outside development',() => {
  const full = fullGameDefinition(1905);
  assert.deepEqual(parseChallenge(full),full);
  assert.throws(() => parseChallenge({ ...TUNIS_PILOT_V1, opponentPowers: [...ALL_POWERS] }),/six other powers/);
  assert.throws(() => parseChallenge({ ...full, opponentPowers: full.opponentPowers.slice(1) }),/all seven powers/);
  assert.throws(() => parseChallenge({ ...TUNIS_PILOT_V1, autoplay: false }),/expected true/);
  assert.doesNotThrow(() => assertDevelopment({})); assert.doesNotThrow(() => assertDevelopment({ NODE_ENV: 'production', DIPLOMACY_PROFILE: 'local' }));
  assert.throws(() => assertDevelopment({ NODE_ENV: 'production' }),/development tool/);
  assert.throws(() => assertDevelopment({ DIPLOMACY_PROFILE: 'showcase' }),/development tool/);
  assert.equal(parseAssignment('austria=haiku, TURKEY=haiku').AUSTRIA,'haiku'); assert.equal(parseAssignment(undefined).ENGLAND,'haiku');
  assert.throws(() => parseAssignment('SPAIN=luna'),/Cannot read/); assert.throws(() => parseAssignment('AUSTRIA=gpt'),/Cannot read/);
});

test('an orders answer that cannot be used is explained, and a game stuck on them continues once more orders calls are allowed',async t => {
  const f = await setup(t);
  let broken = true;
  const asked: string[] = [];
  // Turkey's model names one unit twice, gives another a number from the wrong list, and leaves the third out.
  const transports = f.transports((key,inner) => async request => {
    const contract = opponentContract(key), context = contract.contextOf(request.body);
    if (broken && speaker(context) === 'TURKEY' && contract.buildFullGameRequest({ context },'UNIT_ORDERS').body === request.body) asked.push(context);
    if (broken && speaker(context) === 'TURKEY' && contract.buildFullGameRequest({ context },'UNIT_ORDERS').body === request.body)
      return { status: 200, body: contract.mockEnvelope({ serial: 9_000 + Math.floor(Math.random() * 1e9), text: '{"orders":[{"unit":"F ANK","choice":0},{"unit":"ank","choice":1},{"unit":"CON","choice":999},{"unit":"PAR","choice":1}]}', inputTokens: 100, outputTokens: 40 }) };
    return inner(request);
  });
  const stuck = await f.run({ transports, lastYear: 1901, orderCalls: 3, maxRecoveries: 2 });
  assert.equal(stuck.status,'WAITING');
  const reasons = stuck.record.failures.map(x => x.reason);
  // Each rejected answer says what was wrong with it, in terms of the units, without quoting it.
  const expected = /F ANK was given more than once; 999 is not one of the numbers under A CON \(those are \d+ to \d+\); PAR is not one of your units; no usable order for A CON, A SMY/;
  assert.equal(reasons.filter(r => /^TURKEY orders call, try \d: answer not usable — /.test(r) && expected.test(r)).length,3);
  assert.equal(stuck.record.phases[0].calls.filter(c => c.power === 'TURKEY' && c.outcome === 'INVALID_ACTION').length,3);
  // The first try is the plain request. Each later try tells the model what was wrong with the answer it replaces,
  // in the server's words, and names the units it must cover.
  assert.equal(asked.length,3); assert.ok(!asked[0].includes('could not be used'));
  for (const retry of asked.slice(1)) { assert.match(retry,expected); assert.match(retry,/\nYour previous answer for this turn could not be used: F ANK was given more than once; .+\. Go through the 3 headings above in order and take exactly one number from under each: F ANK, A CON, A SMY\.\nAnswer with \{"orders"/); }
  // No other power's request carries a correction.
  assert.ok(f.sent.filter(x => speaker(x.context) !== 'TURKEY').every(x => !x.context.includes('could not be used')));
  // The limit holds across runs: another run with the same limit buys nothing more and says how to go on.
  const before = f.sent.length, again = await f.run({ transports, lastYear: 1901, orderCalls: 3, maxRecoveries: 2 });
  assert.equal(again.status,'WAITING'); assert.match(again.waitingOn!,/higher --order-calls/); assert.equal(f.sent.length,before);
  broken = false;
  const done = await f.run({ transports, lastYear: 1901, orderCalls: 5 });
  assert.equal(done.status,'FINISHED');
  // The other six powers' first answers were kept; only Turkey was asked again.
  assert.deepEqual(done.record.phases[0].calls.filter(c => c.outcome === 'VALID').map(c => c.power).sort(),[...ALL_POWERS].sort());
  assert.equal(done.record.phases[0].calls.length,7 + 3);
  await assert.rejects(f.run({ orderCalls: 11, lastYear: 1901 }),/between 3 and 10/);
});

test('a provider that refuses requests before they are sent is reported with its status, costs nothing, and is retried with a growing pause',async t => {
  const f = await setup(t);
  // OpenAI's token count answers 429 for every request; Anthropic works.
  const transports = f.transports((key,inner) => {
    if (key !== 'luna') return inner;
    const refused: LunaTransport = async () => { throw new Error('unreachable'); };
    refused.preflight = async () => { throw new PreflightError('Luna input-token preflight unavailable.','HTTP 429'); };
    return refused;
  });
  const waits: number[] = [], lines: string[] = [];
  const result = await f.run({ transports, lastYear: 1901, maxWaits: 3, sleep: async ms => { waits.push(ms); }, log: line => lines.push(line) });
  assert.equal(result.status,'WAITING'); assert.match(result.waitingOn!,/PREFLIGHT \(HTTP 429\)/); assert.match(result.waitingOn!,/Nothing was billed/);
  const reasons = result.record.failures.map(x => x.reason);
  assert.ok(reasons.some(r => /^AUSTRIA message call, try 1: PREFLIGHT \(HTTP 429\) — trying again$/.test(r)));
  assert.ok(reasons.some(r => /^[A-Z]+: PREFLIGHT \(HTTP 429\)$/.test(r)));
  // Each recovery waited longer than the one before, and said so.
  assert.deepEqual(waits,[5_000,10_000,20_000]);
  assert.ok(lines.some(line => line.includes('waiting 5 s before trying again')));
  // Nothing reached the model for those powers, so nothing was billed for them.
  assert.equal(result.record.models['gpt-6-luna']?.costNanousd ?? 0,0);
  assert.equal((await f.store.call('attemptFunding',{ attemptId: result.run.attemptId })).heldNanousd,0);
});

test('a unit-by-unit orders answer is read strictly: every unit once, each number from under its own heading',() => {
  const set = { power: 'FRANCE', phase: 'ORDERS', rule: '', coverage: { listed: 5, total: 5 }, toAction: () => ({ phase: 'ORDERS', orderIds: [] }),
    groups: [{ id: 'BRE', label: 'F BRE', choices: [0,1] },{ id: 'SPA', label: 'F SPA/SOUTH', choices: [2,3,4] }],
    choices: [{ group: 'BRE', label: '' },{ group: 'BRE', label: '' },{ group: 'SPA', label: '' },{ group: 'SPA', label: '' },{ group: 'SPA', label: '' }] } as never;
  // Units may be named as in the heading, with or without the unit type or coast, in any order.
  assert.deepEqual(parseUnitOrders({ orders: [{ unit: 'F SPA/SOUTH', choice: 4 },{ unit: 'bre', choice: 1 }] },set),[1,4]);
  assert.deepEqual(parseUnitOrders({ orders: [{ unit: 'Fleet BRE', choice: 0 },{ unit: 'SPA', choice: 2 }] },set),[0,2]);
  // The mistake a bare list of numbers allowed, two for one unit and none for another, is now named.
  assert.throws(() => parseUnitOrders({ orders: [{ unit: 'BRE', choice: 0 },{ unit: 'BRE', choice: 1 }] },set),/F BRE was given more than once; no usable order for F SPA\/SOUTH/);
  assert.throws(() => parseUnitOrders({ orders: [{ unit: 'BRE', choice: 3 },{ unit: 'SPA', choice: 3 }] },set),/3 is not one of the numbers under F BRE \(those are 0 to 1\); no usable order for F BRE/);
  assert.throws(() => parseUnitOrders({ orders: [{ unit: 'BRE', choice: 0 }] },set),/no usable order for F SPA\/SOUTH/);
  for (const bad of [null,[],{ choices: [0,2] },{ orders: 'x' },{ orders: [{ unit: 'BRE' }] },{ orders: [{ unit: 1, choice: 0 }] },{ orders: [], extra: 1 }])
    assert.throws(() => parseUnitOrders(bad,set),/the answer was not/);
});
