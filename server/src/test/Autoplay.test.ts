import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_POWERS, type Power } from '@diplomacy/shared';
import { CALL_TIMEOUT_MS, DEFAULT_ASSIGNMENT, autoplay, fullGameDefinition, harnessInstructions, quietYears, type ModelKey } from '../autoplay/Autoplay.js';
import { assertDevelopment, harnessVersion, parseAssignment } from '../autoplay/cli.js';
import { ASK_INSTRUCTIONS, FULL_GAME_UNIT_INSTRUCTIONS, OPPONENT_INSTRUCTIONS, REPLY_INSTRUCTIONS } from '../providers/OpponentInstructions.js';
import { noteLines, parseMessages, sharedContext, talkLines, threadLines, type PowerMessage } from '../luna/Context.js';
import { buildChoices, convoyMismatches, noteOf, orderChoices, parseUnitOrders, pendingCaptures, selfBlockingMoves } from '../luna/Choices.js';
import { describeRejection } from '../luna/LunaDecisionProvider.js';
import { http1Fetch } from '../luna/Http1Fetch.js';
import { PreflightError, httpLunaTransport, mockOpponentTransport, networkCode, type LunaTransport } from '../luna/Transport.js';
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
  const sent: Array<{ key: ModelKey; context: string; kind: 'ORDERS' | 'UNIT_ORDERS' | 'ASK' | 'REPLY'; effort: 'low' | 'medium' | 'high' }> = [];
  const transports = (wrap: (key: ModelKey, inner: LunaTransport) => LunaTransport = (_key,inner) => inner) => Object.fromEntries((['luna','haiku'] as const).map(key => {
    const contract = opponentContract(key), inner = mockOpponentTransport(contract,{ pick: 'seeded', seed: 3 });
    const recording: LunaTransport = async request => {
      const context = contract.contextOf(request.body);
      sent.push({ key, context, effort: (['low','medium','high'] as const).find(effort => (['ORDERS','UNIT_ORDERS','ASK','REPLY'] as const).some(kind => contract.buildFullGameRequest({ context },kind,effort).body === request.body))!,
        kind: (['ORDERS','UNIT_ORDERS','ASK','REPLY'] as const).find(kind => (['low','medium','high'] as const).some(effort => contract.buildFullGameRequest({ context },kind,effort).body === request.body))! });
      return inner(request);
    };
    return [key,wrap(key,recording)];
  })) as Record<ModelKey, LunaTransport>;
  const run = (extra: Partial<Parameters<typeof autoplay>[0]> = {}) => autoplay({ store, runId: 'game-a', lastYear: 1902, transports: transports(), transportKind: 'mock', now: () => 1_800_000_000_000,
    // The stand-ins often send two units to one place; these tests count calls, so the extra question is asked only where a test turns it on.
    askAgainWhenBlocked: false, ...extra });
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
    // A request only ever shows messages this power sent or received: in an orders request as one list, in a
    // message request as one thread per power, each holding only that power and this one. Its own notes are separate.
    let section: string | null = null;
    for (const line of context.split('\n')) {
      const thread = /^Your conversation with ([A-Z]+), oldest first:$/.exec(line);
      if (thread || /^Your own private notes/.test(line) || /^Your private messages with other powers, oldest first/.test(line)) { section = thread ? thread[1] : /notes/.test(line) ? 'NOTES' : 'LIST'; continue; }
      if (!/^\[[A-Z]+ \d{4}\] /.test(line) || section === 'NOTES') continue;
      assert.match(line,section === 'LIST' ? /^\[[A-Z]+ \d{4}\] (You to [A-Z]+|[A-Z]+ to you): / : new RegExp(`^\\[[A-Z]+ \\d{4}\\] (You|${section}): `),`${me}: ${line}`);
    }
  }
  // Orders are asked for unit by unit; retreats and builds remain a plain list of numbers.
  assert.ok(orders.every(s => s.context.includes('ORDERS phase') && /\nAnswer with \{"orders":\[\{"unit":"[A-Z]{3}","choice":\d+\}, \.\.\.\],"note":"\.\.\."\}: one entry for each heading above/.test(s.context)));
  assert.ok(f.sent.filter(s => s.kind === 'ORDERS').every(s => !s.context.includes('ORDERS phase') && s.context.includes('Answer with {"choices":[...]}')));
  // A reply request shows the message it answers; an opening request of the first turn has none to show.
  const firstAsk = f.sent.find(s => s.kind === 'ASK')!, firstReply = f.sent.find(s => s.kind === 'REPLY')!;
  assert.ok(!firstAsk.context.includes('Your conversation with ')); assert.match(firstAsk.context,/\nYou have not exchanged messages with [A-Z]+ yet\./); assert.match(firstAsk.context,/\nYou may write to up to 3 of: /);
  assert.match(firstReply.context,/\nYour conversation with [A-Z]+, oldest first:\n\[SPRING 1901\] (You|[A-Z]+): /); assert.match(firstReply.context,/\nReply to: /);
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
  assert.equal(result.status,'WAITING'); assert.match(result.waitingOn!,/a budget is used up/);
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

test('with more free home centers than builds, the rule says to choose among them, and an answer with one per center is explained',() => {
  const unit = (territory: string) => ({ id: territory, power: 'ITALY', type: 'ARMY', territory, coast: null, mustRetreat: false, retreatOptions: [], retreatCoasts: {} });
  const board = { year: 1929, season: 'WINTER', phase: 'BUILDS', territoryOwners: { ROM: 'ITALY', NAP: 'ITALY', VEN: 'ITALY', TUN: 'ITALY' }, units: [unit('TUN'),unit('PIE'),unit('TUS')] } as never;
  const one = buildChoices(board,'ITALY')!;
  assert.equal(one.groups.length,3);
  assert.match(one.rule,/^Pick up to 1 number in total, at most one per home center\. You have 3 free home centers but only 1 build, so choose which center to build in: do not pick one number under every heading\. An empty list waives your builds\.$/);
  assert.throws(() => one.toAction([one.groups[0].choices[0],one.groups[1].choices[0]]),/Too many builds/);
  assert.equal(describeRejection({ choices: [one.groups[0].choices[0],one.groups[1].choices[0]] },one),'2 numbers for 3 slots; the rule allows 1 in total, not one under every heading');
  // As many builds as free centers needs no such warning.
  const all = buildChoices({ ...(board as object), units: [] } as never,'ITALY')!;
  assert.equal(all.rule,'Pick up to 3 numbers in total, at most one per home center. An empty list waives your builds.');
});

test('a full game\'s requests state the standings, name whose unit a support helps, and mark moves two units share',async t => {
  const f = await setup(t); await f.run();
  // Every request, from the first, says the score outright.
  assert.ok(f.sent.every(s => /\nStandings \(18 supply centers win\): ([A-Z]+ \d+, ){6}[A-Z]+ \d+\.\n/.test(s.context)));
  const orders = f.sent.filter(s => s.kind === 'UNIT_ORDERS');
  // Two of a power's units that can reach the same place are marked on both moves, and the rule explains the mark.
  const marked = orders.filter(s => / \([^)\n]*shared with [AF] [A-Z]{3}/.test(s.context));
  assert.ok(marked.length > 0);
  assert.ok(marked.every(s => s.context.includes('"Shared with" names other units of yours that can move to the same place: send only one of them there, or both fail.')));
  // A support or convoy for another power's unit says whose it is; one for your own unit says nothing.
  const helping = orders.flatMap(s => s.context.split('\n').filter(line => /^\d+ [A-Z]{3} (supports|convoys) /.test(line)).map(line => ({ me: speaker(s.context), line })));
  assert.ok(helping.some(h => /\(([A-Z]+)'s unit\)$/.test(h.line)));
  for (const h of helping) { const owner = /\(([A-Z]+)'s unit\)$/.exec(h.line)?.[1]; assert.notEqual(owner,h.me); }
});

test('the leader is named with its distance from winning, and the notes give way before last turn\'s results do',() => {
  const definition = fullGameDefinition(1999), unit = (power: string, territory: string, type = 'ARMY') => ({ id: `${power}-${territory}`, power, type, territory, coast: null, mustRetreat: false, retreatOptions: [], retreatCoasts: {} });
  const centers = (power: string, ids: string[]) => Object.fromEntries(ids.map(id => [id,power]));
  const board = { year: 1930, season: 'SPRING', phase: 'ORDERS', units: [unit('ITALY','ROM'),unit('ITALY','VEN'),unit('ENGLAND','LON')],
    territoryOwners: { ...centers('ITALY',['ROM','NAP','VEN','TUN','GRE','SER','BUL','CON','SMY','ANK','TRI','VIE','BUD','MAR','SPA','POR','PAR']), ...centers('ENGLAND',['LON','EDI','LVP']) } } as never;
  const text = sharedContext({ board, definition },null);
  assert.match(text,/\nStandings \(18 supply centers win\): ITALY 17, ENGLAND 3, AUSTRIA 0, FRANCE 0, GERMANY 0, RUSSIA 0, TURKEY 0\.\nITALY leads and needs 1 more supply center to win\. If ITALY reaches 18 the game ends and every other power has lost\.\n/);
  // No leader is singled out while the game is even, and a played-to-a-win game names no end year.
  const even = sharedContext({ board: { ...(board as object), territoryOwners: { ...centers('ITALY',['ROM','NAP','VEN']), ...centers('ENGLAND',['LON','EDI','LVP']) } } as never, definition },null);
  assert.ok(!even.includes(' leads and needs ')); assert.ok(even.includes('The game ends as soon as one power owns 18 supply centers.'));
  // A challenge request is unchanged: no standings line.
  assert.ok(!sharedContext({ board, definition: TUNIS_PILOT_V1 },null).includes('Standings'));
  // Rome and Venice can both move to Tuscany and Apulia... the mark appears when the notes are on and not otherwise.
  const move = (from: string, to: string) => ({ id: `${from}|MOVE|${to}`, unitTerritory: from, description: `${from} moves to ${to}`, order: { power: 'ITALY', type: 'MOVE', unitTerritory: from, targetTerritory: to } });
  const hold = (from: string) => ({ id: `${from}|HOLD`, unitTerritory: from, description: `${from} holds`, order: { power: 'ITALY', type: 'HOLD', unitTerritory: from } });
  const legal = [hold('ROM'),hold('VEN'),move('ROM','TUS'),move('VEN','TUS'),move('VEN','TYR')] as never;
  const withNotes = orderChoices(board,'ITALY',legal)!, without = orderChoices(board,'ITALY',legal,undefined,undefined,undefined,false)!;
  assert.deepEqual(withNotes.choices.map(c => c.label),['ROM moves to TUS (shared with A VEN)','ROM holds','VEN moves to TUS (shared with A ROM)','VEN moves to TYR','VEN holds']);
  assert.deepEqual(without.choices.map(c => c.label),['ROM moves to TUS','ROM holds','VEN moves to TUS','VEN moves to TYR','VEN holds']);
  assert.ok(withNotes.rule.includes('"Shared with"') && !without.rule.includes('"Shared with"'));
});

test('a game with no year to stop at ends as a stalemate once no supply center has changed hands for the stated years, and stays continuable',async t => {
  const owners = (o: Record<string, string>) => ({ after: { territoryOwners: o } });
  assert.equal(quietYears([]),0);
  assert.equal(quietYears([{ year: 1901, ...owners({ VIE: 'AUSTRIA' }) },{ year: 1902, ...owners({ VIE: 'ITALY' }) },{ year: 1903, ...owners({ VIE: 'ITALY' }) },{ year: 1905, ...owners({ VIE: 'ITALY' }) }]),3);
  // Changing hands and back again is not quiet.
  assert.equal(quietYears([{ year: 1901, ...owners({ VIE: 'AUSTRIA' }) },{ year: 1904, ...owners({ VIE: 'ITALY' }) },{ year: 1905, ...owners({ VIE: 'AUSTRIA' }) }]),0);

  // Stand-ins that hold every unit: nothing ever changes hands.
  const f = await setup(t), still = () => Object.fromEntries((['luna','haiku'] as const).map(key => [key,mockOpponentTransport(opponentContract(key),{ pick: 'first' })])) as Record<ModelKey, LunaTransport>;
  const lines: string[] = [];
  const ended = await f.run({ lastYear: 1950, transports: still(), stalemateYears: 2, log: line => lines.push(line) });
  assert.equal(ended.status,'FINISHED'); assert.equal(ended.endedBy,'STALEMATE'); assert.equal(ended.waitingOn,null); assert.equal(ended.summary.winner,null);
  assert.equal(ended.summary.year,1903);
  assert.ok(lines.some(line => /No supply center has changed hands for 2 years/.test(line)));
  // The game itself is untouched: the same verdict again costs nothing, and a larger limit plays on.
  assert.equal(ended.record.attempt.lifecycle,'ACTIVE');
  const again = await f.run({ lastYear: 1950, transports: still(), stalemateYears: 2 });
  assert.equal(again.endedBy,'STALEMATE'); assert.equal(again.summary.calls,ended.summary.calls); assert.equal(again.summary.settledNanousd,ended.summary.settledNanousd);
  const on = await f.run({ lastYear: 1950, transports: still(), stalemateYears: 3 });
  assert.equal(on.endedBy,'STALEMATE'); assert.equal(on.summary.year,1904); assert.ok(on.summary.calls > ended.summary.calls);
  await assert.rejects(f.run({ stalemateYears: -1 }),/stalemate limit/);
});

test('a record states the code and the standing orders instructions it was played under, and calls get the longer full-game limit',async t => {
  const f = await setup(t), result = await f.run({ lastYear: 1901, harness: { commit: 'a'.repeat(40), modified: true } });
  assert.deepEqual(result.run.harness,{ commit: 'a'.repeat(40), modified: true, ...harnessInstructions(), callTimeoutMs: CALL_TIMEOUT_MS, stalemateYears: 0, askAgainWhenBlocked: false, effort: 'low' });
  assert.equal(result.run.harness!.ordersInstructions,FULL_GAME_UNIT_INSTRUCTIONS);
  assert.match(result.run.harness!.instructionsHash,/^[0-9a-f]{16}$/);
  assert.equal(CALL_TIMEOUT_MS,40_000);
  // The challenge's own pinned limits are not what changed.
  assert.equal(OPPONENT_CONTRACTS.luna.preset.timeoutMs,20_000); assert.equal(OPPONENT_CONTRACTS.haiku.preset.timeoutMs,20_000);
  assert.notEqual(OPPONENT_INSTRUCTIONS,FULL_GAME_UNIT_INSTRUCTIONS);
  // Unknown without a caller to say; from a checkout, git's full commit id.
  assert.deepEqual((await f.run({ runId: 'game-b', lastYear: 1901 })).run.harness!.commit,null);
  const version = harnessVersion();
  assert.ok(version.commit === null || /^[0-9a-f]{40}$/.test(version.commit));
});

test('a full game\'s hold rule makes holding the exception; the challenge keeps its own pinned wording',() => {
  const challengeRule = 'Hold a unit only when it sits on one of your supply centers that another power could reach this turn';
  assert.ok(OPPONENT_INSTRUCTIONS.includes(challengeRule));
  for (const key of ['luna','haiku'] as const) for (const kind of ['ORDERS','UNIT_ORDERS'] as const) {
    const body = OPPONENT_CONTRACTS[key].buildFullGameRequest({ context: 'x' },kind).body;
    assert.ok(!body.includes(challengeRule));
    assert.ok(body.includes('A rival unit next to one of your supply centers is not by itself a reason to hold there.'));
    assert.ok(body.includes('in Spring a unit can leave its center'));
  }
  // The challenge's request is byte for byte what its preset pins.
  assert.ok(OPPONENT_CONTRACTS.haiku.buildRequest({ context: 'x' }).body.includes(challengeRule));
});

test('a token count that fails says why: the HTTP status even behind a large error page, the system\'s code, or the kind of error',async () => {
  const body = OPPONENT_CONTRACTS.luna.buildFullGameRequest({ context: 'x' },'ASK').body, signal = new AbortController().signal;
  const detail = async (fetchImpl: typeof fetch) => { try { await httpLunaTransport('test-key-not-real',fetchImpl).preflight!({ body, signal }); return 'counted'; } catch (error) { return error instanceof PreflightError ? error.detail : 'other'; } };
  // An error page far larger than a count is still an HTTP status, not a lost connection.
  assert.equal(await detail((async () => new Response('<html>' + 'x'.repeat(20_000),{ status: 429 })) as typeof fetch),'HTTP 429');
  assert.equal(await detail((async () => new Response('<html>' + 'x'.repeat(20_000),{ status: 403 })) as typeof fetch),'HTTP 403');
  assert.equal(await detail((async () => new Response('x'.repeat(20_000))) as typeof fetch),'no connection, ResponseTooLarge');
  assert.equal(await detail((async () => { throw Object.assign(new TypeError('fetch failed: secret text'),{ cause: Object.assign(new Error('secret'),{ code: 'ECONNRESET' }) }); }) as typeof fetch),'no connection, ECONNRESET');
  // One failure per address tried, wrapped twice.
  const perAddress = Object.assign(new Error('x'),{ name: 'AggregateError', errors: [Object.assign(new Error('a'),{ code: 'ETIMEDOUT' }),Object.assign(new Error('b'),{ code: 'ENETUNREACH' })] });
  assert.equal(networkCode(Object.assign(new TypeError('fetch failed'),{ cause: perAddress })),', ETIMEDOUT/ENETUNREACH');
  assert.equal(networkCode(new TypeError('some secret text')),', TypeError');
  assert.equal(networkCode({ code: 'not a code!' }),'');
  assert.equal(networkCode(null),'');
});

test('the tools\' plain HTTP/1.1 fetch sends exact bytes on its own connection, returns any status without following it, and honours cancellation and a size limit',async t => {
  const seen: Array<{ method: string; url: string; auth: string; encoding: string; connection: string; body: string }> = [];
  const server = createServer((req,res) => {
    const chunks: Buffer[] = [];
    req.on('data',c => chunks.push(c)).on('end',() => {
      seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization), encoding: String(req.headers['accept-encoding']), connection: String(req.headers.connection), body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/moved') { res.writeHead(307,{ location: '/elsewhere' }); res.end('x'.repeat(10_000)); }
      else if (req.url === '/huge') { res.writeHead(200); res.end('x'.repeat(2 * 1024 * 1024)); }
      else if (req.url === '/slow') { /* never answers */ }
      else { res.writeHead(200,{ 'content-type': 'application/json', 'request-id': 'req_1' }); res.end('{"object":"response.input_tokens","input_tokens":100}'); }
    });
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, body = JSON.stringify({ text: 'é'.repeat(20_000) });
  const ok = await http1Fetch(`${base}/count`,{ method: 'POST', headers: { Authorization: 'Bearer test-key-not-real', 'Content-Type': 'application/json' }, body });
  assert.equal(ok.status,200); assert.equal(ok.headers.get('request-id'),'req_1'); assert.deepEqual(await ok.json(),{ object: 'response.input_tokens', input_tokens: 100 });
  assert.deepEqual(seen[0],{ method: 'POST', url: '/count', auth: 'Bearer test-key-not-real', encoding: 'identity', connection: 'close', body });
  // A redirect is an answer with a status, never followed and never an unnamed failure.
  const moved = await http1Fetch(`${base}/moved`,{ method: 'POST', body: 'x' });
  assert.equal(moved.status,307); assert.equal(seen.length,2);
  await assert.rejects(http1Fetch(`${base}/huge`),{ name: 'ResponseTooLarge' });
  const stop = new AbortController(), slow = http1Fetch(`${base}/slow`,{ signal: stop.signal });
  setTimeout(() => stop.abort(),30);
  await assert.rejects(slow,{ name: 'AbortError' });
  await assert.rejects(http1Fetch(`${base}/x`,{ signal: AbortSignal.abort() }));
  await assert.rejects(http1Fetch('ftp://example.invalid/x'),TypeError);
  // Nothing listening: the system's code is there to report.
  const closed = createServer(); closed.listen(0,'127.0.0.1'); await once(closed,'listening');
  const dead = `http://127.0.0.1:${(closed.address() as { port: number }).port}`; closed.close(); await once(closed,'close');
  await assert.rejects(http1Fetch(dead),(error: unknown) => networkCode(error) === ', ECONNREFUSED');
  // Through the transport, a redirect from the count endpoint is reported as its status.
  const request = OPPONENT_CONTRACTS.luna.buildFullGameRequest({ context: 'x' },'ASK').body;
  const redirected = httpLunaTransport('test-key-not-real',((_url,init) => http1Fetch(`${base}/moved`,init)) as typeof fetch);
  await assert.rejects(redirected.preflight!({ body: request, signal: new AbortController().signal }),(error: unknown) => error instanceof PreflightError && error.detail === 'HTTP 307');
});

test('orders that block each other are named and asked about once; the second answer stands whatever it says',async t => {
  assert.deepEqual(selfBlockingMoves(['ANK|MOVE|ARM','CON|HOLD','SMY|MOVE|ARM']),['your units in ANK and SMY were all sent to ARM, where only one can arrive']);
  assert.deepEqual(selfBlockingMoves(['ANK|MOVE|CON','CON|SUPPORT_HOLD|SMY','SMY|MOVE|ARM']),['your unit in ANK was sent to CON, where your own unit is staying']);
  assert.deepEqual(selfBlockingMoves(['SPA/SOUTH|MOVE|MAO','GAS|MOVE|MAO','POR|MOVE_VIA_CONVOY|MAO','BRE|MOVE|PAR']),['your units in SPA/SOUTH, GAS and POR were all sent to MAO, where only one can arrive']);
  // Moving into a place your own unit is leaving, or supporting into it, is fine.
  assert.deepEqual(selfBlockingMoves(['ANK|MOVE|CON','CON|MOVE|BUL','SMY|SUPPORT_MOVE|ANK|CON']),[]);

  const f = await setup(t), asked: string[] = [];
  // Turkey's model sends F ANK and A SMY both to Armenia, every time it is asked.
  const transports = f.transports((key,inner) => async request => {
    const contract = opponentContract(key), context = contract.contextOf(request.body);
    if (speaker(context) === 'TURKEY' && contract.buildFullGameRequest({ context },'UNIT_ORDERS').body === request.body && /SPRING 1901, ORDERS phase\./.test(context)) {
      asked.push(context);
      // Numbers are looked up by the order's words, so the test does not depend on what else is listed.
      const pick = (order: string) => Number(new RegExp(`^(\\d+) ${order}( \\(|$)`,'m').exec(context)![1]);
      const text = JSON.stringify({ orders: [{ unit: 'ANK', choice: pick('ANK moves to ARM') },{ unit: 'CON', choice: pick('CON holds') },{ unit: 'SMY', choice: pick('SMY moves to ARM') }] });
      return { status: 200, body: contract.mockEnvelope({ serial: 7_000 + asked.length, text, inputTokens: 100, outputTokens: 40 }) };
    }
    return inner(request);
  });
  const result = await f.run({ transports, lastYear: 1901, askAgainWhenBlocked: true });
  assert.equal(result.status,'FINISHED'); assert.equal(result.run.harness!.askAgainWhenBlocked,true);
  assert.equal(asked.length,2);
  assert.ok(!asked[0].includes('could not be used'));
  assert.match(asked[1],/\nYour previous answer for this turn could not be used: your units in ANK and SMY were all sent to ARM, where only one can arrive\. Those orders cannot all work as given; change them, or keep them if you meant them, since your next answer is played as it is\. Go through the 3 headings/);
  const spring = result.record.phases[0];
  assert.deepEqual(spring.calls.filter(c => c.power === 'TURKEY').map(c => c.outcome),['INVALID_ACTION','VALID']);
  // The second answer was played as given.
  assert.deepEqual((spring.report as unknown as { resolvedOrders: Array<{ power: string; type: string; targetTerritory: string }> }).resolvedOrders.filter(o => o.power === 'TURKEY' && o.type === 'MOVE').map(o => o.targetTerritory),['ARM','ARM']);
  assert.ok(result.record.failures.some(x => /^TURKEY orders call, try 1: answer not usable — your units in ANK and SMY were all sent to ARM/.test(x.reason)));
});

test('a full game says only a solo win counts and how convoys work, shows which fleet moves would open a convoy, and asks once about a convoy missing its other half',async t => {
  for (const text of [FULL_GAME_UNIT_INSTRUCTIONS,ASK_INSTRUCTIONS,REPLY_INSTRUCTIONS]) assert.match(text,/Only a solo win counts/);
  assert.match(FULL_GAME_UNIT_INSTRUCTIONS,/A fleet in a coastal province cannot convoy/);
  // The challenge keeps its own pinned instructions.
  assert.doesNotMatch(OPPONENT_INSTRUCTIONS,/solo win counts|coastal province cannot convoy/);

  assert.deepEqual(convoyMismatches(['LON|MOVE_VIA_CONVOY|NOR','NTH|HOLD']),['your army in LON was sent to NOR by convoy, but none of your fleets was ordered to convoy it (keep that only if another power agreed to convoy it)']);
  assert.deepEqual(convoyMismatches(['LON|HOLD','NTH|CONVOY|LON|NOR']),['your fleet in NTH was ordered to convoy LON to NOR, but your army in LON was not ordered to move there by convoy']);
  assert.deepEqual(convoyMismatches(['LON|MOVE_VIA_CONVOY|NOR','NTH|CONVOY|LON|NOR']),[]);
  // Convoying another power's army is that power's business.
  assert.deepEqual(convoyMismatches(['NTH|CONVOY|BEL|NOR']),[]);

  const f = await setup(t), result = await f.run({ lastYear: 1901 });
  assert.equal(result.status,'FINISHED'); assert.equal(result.run.contextVersion,'luna-context-v8');
  const turkey = f.sent.find(x => x.kind === 'UNIT_ORDERS' && speaker(x.context) === 'TURKEY' && /SPRING 1901, ORDERS phase\./.test(x.context))!.context;
  // The hint comes before the numbered list, so no line between the headings looks like one.
  assert.match(turkey,/\nConvoys you could set up for next turn\. Only a fleet at sea next to an army can convoy it; a fleet in a coastal province cannot\.\n- A CON: move F ANK to BLA this turn, and next turn A CON can be convoyed from there to ARM, RUM, SEV\.\nPick exactly one number/);
});

test('in a Fall turn a full game says which centers are about to change hands, and what staying or leaving does to each',() => {
  const definition = fullGameDefinition(1950), unit = (power: string, territory: string) => ({ id: `${power}-${territory}`, power, type: 'ARMY', territory, coast: null, mustRetreat: false, retreatOptions: [], retreatCoasts: {} });
  // Turkey stands on unowned Bulgaria and on Austria's Serbia; Austria stands on its own Vienna.
  const board = (season: string) => ({ year: 1905, season, phase: 'ORDERS', units: [unit('TURKEY','BUL'),unit('TURKEY','SER'),unit('AUSTRIA','VIE')],
    territoryOwners: { SER: 'AUSTRIA', VIE: 'AUSTRIA', BUL: null } }) as never;
  assert.deepEqual(pendingCaptures(board('FALL')),[{ center: 'BUL', power: 'TURKEY', from: null, unit: 'A BUL' },{ center: 'SER', power: 'TURKEY', from: 'AUSTRIA', unit: 'A SER' }]);
  assert.deepEqual(pendingCaptures(board('SPRING')),[]);
  // Every power is told, as the map shows it.
  assert.match(sharedContext({ board: board('FALL'), definition },null),/\nThis Fall decides who owns supply centers\. If the units now on them are still there when the turn ends: BUL becomes TURKEY's \(now unowned\); SER becomes TURKEY's \(now AUSTRIA's\)\.\n/);
  assert.ok(!sharedContext({ board: board('SPRING'), definition },null).includes('This Fall decides'));
  assert.ok(!sharedContext({ board: board('FALL'), definition: TUNIS_PILOT_V1 },null).includes('This Fall decides'));
  const option = (from: string, type: string, to?: string) => ({ id: to ? `${from}|${type}|${to}` : `${from}|${type}`, unitTerritory: from, description: to ? `${from} moves to ${to}` : `${from} holds`, order: { power: 'TURKEY', type, unitTerritory: from, targetTerritory: to } });
  const legal = [option('BUL','HOLD'),option('BUL','MOVE','RUM'),option('SER','HOLD'),option('SER','MOVE','ALB')] as never;
  const set = orderChoices(board('FALL'),'TURKEY',legal,undefined,undefined,undefined,true,{ captures: true })!;
  assert.deepEqual(set.choices.map(c => c.label),['BUL moves to RUM (unowned supply center) (leaving gives up BUL, which becomes yours after this Fall if this unit stays)','BUL holds (staying takes BUL after this Fall)',
    'SER moves to ALB (leaving gives up SER, which becomes yours after this Fall if this unit stays)','SER holds (staying takes SER after this Fall)']);
  assert.deepEqual(set.notes,['Supply centers that become yours after this Fall only if the unit on each is still there when the turn ends: BUL (A BUL), SER (A SER). Moving that unit away gives the center up unless another of your units moves in.']);
  // Without the full-game notes, the list is as before.
  assert.ok(!orderChoices(board('FALL'),'TURKEY',legal)!.choices.some(c => c.label.includes('after this Fall')));
  assert.match(FULL_GAME_UNIT_INSTRUCTIONS,/takes it only by still being there when the turn ends/);
  assert.doesNotMatch(OPPONENT_INSTRUCTIONS,/takes it only by still being there/);
});

test('a power keeps a private note with its orders that only it is shown later, and writes to others with their whole thread in view',async t => {
  assert.equal(noteOf({ orders: [], note: '  Promised  France\nBelgium.  ' }),'Promised France Belgium.');
  assert.equal(noteOf({ orders: [], note: '   ' }),null); assert.equal(noteOf({ orders: [] }),null); assert.equal(noteOf({ orders: [], note: 'x'.repeat(900) })!.length,400);
  // Threads are per power, oldest first; a long thread keeps its newest messages within its share of the budget.
  const said: PowerMessage[] = [{ when: 'SPRING 1901', from: 'FRANCE', to: 'ENGLAND', body: 'old' },{ when: 'SPRING 1901', from: 'GERMANY', to: 'ENGLAND', body: 'hi' },
    { when: 'FALL 1930', from: 'ENGLAND', to: 'FRANCE', body: 'new' },{ when: 'FALL 1930', from: 'ITALY', to: 'RUSSIA', body: 'not mine' }];
  assert.deepEqual(threadLines('ENGLAND',said,['FRANCE','ITALY']),['Your conversation with FRANCE, oldest first:','[SPRING 1901] FRANCE: old','[FALL 1930] You: new','You have not exchanged messages with ITALY yet.']);
  assert.deepEqual(threadLines('ENGLAND',said,['FRANCE'],40),['Your conversation with FRANCE, oldest first:','[FALL 1930] You: new']);
  assert.deepEqual(noteLines([{ when: 'FALL 1905', note: 'a' },{ when: 'FALL 1906', note: 'b' }],18),['Your own private notes from earlier turns, oldest first. Only you can see them:','[FALL 1906] b']);

  const f = await setup(t), result = await f.run();
  // Every power's orders call wrote a note; the record has them by phase.
  const spring = result.record.phases.find(p => p.report?.phase === 'ORDERS')!;
  assert.deepEqual(spring.notes!.map(n => n.power).sort(),[...ALL_POWERS].sort());
  assert.ok(spring.notes!.every(n => n.note === `(stand-in, no model was asked) ${n.power} wrote this note.`));
  // Later requests show a power its own notes and nobody else's, in orders and message requests alike.
  const later = f.sent.filter(x => x.context.includes('Your own private notes'));
  assert.ok(later.some(x => x.kind === 'UNIT_ORDERS') && later.some(x => x.kind === 'ASK') && later.some(x => x.kind === 'REPLY'));
  for (const { context } of later) for (const line of context.split('\n').filter(l => l.includes('wrote this note.'))) assert.match(line,new RegExp(` ${speaker(context)} wrote this note\\.$`));
  // A note is never stored for a message call, and only once per orders call.
  const ask = (await f.store.call('providerCallsForAttempt',{ attemptId: result.run.attemptId })).find(c => c.role === 'ASK')!;
  await assert.rejects(f.store.call('savePowerNote',{ callId: ask.id, note: 'x', now: 1 }),/Invalid power note/);
});

test('a full game can be played at a higher reasoning effort: every request, reservation and limit follows it, and a game keeps one effort',async t => {
  for (const key of ['luna','haiku'] as const) {
    const contract = OPPONENT_CONTRACTS[key], low = JSON.parse(contract.buildFullGameRequest({ context: 'x' },'UNIT_ORDERS').body), medium = JSON.parse(contract.buildFullGameRequest({ context: 'x' },'UNIT_ORDERS','medium').body);
    const effortOf = (b: { reasoning?: { effort: string }; output_config?: { effort: string } }) => b.reasoning?.effort ?? b.output_config?.effort;
    const ceilingOf = (b: { max_output_tokens?: number; max_tokens?: number }) => b.max_output_tokens ?? b.max_tokens;
    assert.equal(effortOf(low),'low'); assert.equal(effortOf(medium),'medium'); assert.equal(ceilingOf(medium),contract.fullGameOutputTokens.medium);
    assert.ok(contract.fullGameOutputTokens.medium > contract.fullGameOutputTokens.low);
    // The worst case reserved grows with the ceiling; the challenge's request is untouched.
    assert.ok(contract.reservationNanousd(contract.preset.maxInputTokens,contract.fullGameOutputTokens.medium) > contract.reservationNanousd(contract.preset.maxInputTokens));
    assert.equal(effortOf(JSON.parse(contract.buildRequest({ context: 'x' }).body)),'low');
    assert.throws(() => contract.reservationNanousd(1000,5000),/ceiling/);
  }
  // A bill above the low ceiling is an error unless the request allowed it.
  const bill = (outputTokens: number) => OPPONENT_CONTRACTS.luna.mockEnvelope({ serial: 1, text: '{"choices":[]}', inputTokens: 100, outputTokens });
  assert.equal(OPPONENT_CONTRACTS.luna.normalizeResponse(bill(5000),200).status,'ERROR');
  assert.equal(OPPONENT_CONTRACTS.luna.normalizeResponse(bill(5000),200,8192).status,'COMPLETED');

  const f = await setup(t), result = await f.run({ lastYear: 1901, effort: 'medium' });
  assert.equal(result.status,'FINISHED'); assert.equal(result.run.harness!.effort,'medium'); assert.equal(result.run.harness!.callTimeoutMs,90_000);
  assert.ok(f.sent.length > 0 && f.sent.every(x => x.effort === 'medium'));
  // Continuing the same game at another effort is refused before anything is bought.
  const before = f.sent.length;
  await assert.rejects(f.run({ lastYear: 1901, effort: 'high' }),/different reasoning effort/);
  await assert.rejects(f.run({ lastYear: 1901 }),/different reasoning effort/);
  assert.equal(f.sent.length,before);
  await assert.rejects(f.run({ runId: 'game-z', effort: 'extreme' as never }),/low, medium or high/);
});
