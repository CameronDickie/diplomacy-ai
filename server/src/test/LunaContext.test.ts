import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ALL_POWERS, TERRITORIES } from '@diplomacy/shared';
import type { Power } from '@diplomacy/shared';
import { importScenario, challengeDefinition } from '../fixtures/ScenarioFixture.js';
import { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseJob } from '../attempts/types.js';
import { LUNA_PRESET, lunaReservationNanousd } from '../providers/LunaPreset.js';
import { ChoiceError, buildChoices, forcedAction, orderChoices, parseChoices, retreatChoices, type LegalOption } from '../luna/Choices.js';
import { lunaPrompt, sharedContext } from '../luna/Context.js';

const rules = new PhaseRules(), signal = () => new AbortController().signal;
async function job(name: string, human?: Power): Promise<Pick<PhaseJob,'board' | 'definition'> & PhaseJob> {
  const raw = JSON.parse(readFileSync(new URL(`../../fixtures/development/${name}.v1.json`,import.meta.url),'utf8'));
  raw.objective ??= { humanPower: human ?? 'TURKEY', territory: 'TUN', deadlineYear: 1905, earlyAchievementYear: 1902 };
  const fixture = await importScenario(raw), definition = challengeDefinition(fixture)!;
  // The human's accepted action is present on the job, exactly as the coordinator holds it.
  return { operationId: 'op', attemptId: 'attempt', phaseId: 'phase', revision: 1, status: 'DECIDING', playerId: 'player', requestId: 'request', board: fixture.board, definition,
    humanAction: { phase: 'ORDERS', orderIds: ['SENTINEL-HUMAN-ORDER'] }, decisions: null, reportOffset: 0, createdAt: 0 };
}
const legalFor = async (j: PhaseJob, power: Power): Promise<LegalOption[]> => j.board.phase === 'ORDERS' ? rules.legal(j.board,power,signal()) : [];
const holds = (set: NonNullable<ReturnType<typeof orderChoices>>) => set.groups.map(g => g.choices[0]);

test('opening prompts fit the preset, share one prefix, list every legal option and never show the human\'s orders or another power\'s options',async()=>{
  const j = await job('tunis-expedition'), prompts = [];
  for (const power of j.definition.opponentPowers) prompts.push(lunaPrompt(j,power,await legalFor(j,power),null)!);
  assert.equal(prompts.length,6);
  const shared = sharedContext(j,null), humanOptions = await legalFor(j,'TURKEY');
  for (const p of prompts) {
    assert.ok(p.context.startsWith(`${shared}\n\nYou are ${p.power}.`),p.power);
    assert.deepEqual([p.measured.compacted,p.measured.listed],[false,p.measured.total],p.power);
    assert.ok(p.measured.contextBytes <= 2_500 && p.measured.contextBytes <= LUNA_PRESET.maxContextBytes,`${p.power} ${p.measured.contextBytes}`);
    assert.ok(p.measured.requestBytes >= p.measured.contextBytes && p.measured.requestBytes <= LUNA_PRESET.maxRequestBytes);
    assert.equal(p.maxCostNanousd,lunaReservationNanousd(LUNA_PRESET.maxInputTokens));
    // Reserve all accepted input plus capped output; bytes alone do not prove the input tokens.
    assert.equal(p.maxCostNanousd,5_120_000);
    assert.match(p.context,/goal is to own TUN after a Fall turn no later than Fall 1903/);
    for (const group of p.set.groups) assert.match(p.set.choices[group.choices[0]].label,/hold/i,`${p.power} ${group.id}`);
    assert.ok(!p.context.includes('SENTINEL') && !p.request.body.includes('SENTINEL'));
    for (const option of humanOptions.filter(o => o.order.type !== 'HOLD')) assert.ok(!p.context.includes(option.description),`${p.power} sees ${option.description}`);
    for (const other of j.definition.opponentPowers.filter(o => o !== p.power))
      for (const option of (await legalFor(j,other)).filter(o => o.order.type !== 'HOLD')) assert.ok(!p.context.includes(`\n${option.description}`) && !new RegExp(`\\d ${option.description}(\\n|$)`).test(p.context),`${p.power} sees ${other}: ${option.description}`);
  }
  // Same inputs give the same bytes and hash; a different power gives a different request.
  const again = lunaPrompt(j,'FRANCE',await legalFor(j,'FRANCE'),null)!, france = prompts.find(p => p.power === 'FRANCE')!;
  assert.equal(again.request.requestHash,france.request.requestHash);assert.equal(again.request.body,france.request.body);
  assert.equal(new Set(prompts.map(p => p.request.requestHash)).size,6);
  assert.throws(() => lunaPrompt(j,'TURKEY',humanOptions,null),ChoiceError);
  assert.equal(shared,[
    'Diplomacy, standard map. SPRING 1901, ORDERS phase.',
    'Scenario "Tunis expedition": TURKEY is played by a human whose goal is to own TUN after a Fall turn no later than Fall 1903. Every other power is played separately and looks after its own interests.',
    'Supply centers:','AUSTRIA: BUD TRI VIE','ENGLAND: EDI LON LVP','FRANCE: BRE MAR PAR','GERMANY: BER KIE MUN','ITALY: NAP ROM VEN','RUSSIA: MOS SEV STP WAR','TURKEY: ANK CON SMY',
    'Unowned: BEL BUL DEN GRE HOL NOR POR RUM SER SPA SWE TUN',
    'Units:','AUSTRIA: A BUD, F TRI, A VIE','ENGLAND: F EDI, F LON, A LVP','FRANCE: F BRE, A MAR, A PAR','GERMANY: A BER, F KIE, A MUN','ITALY: F NAP, A ROM, A VEN','RUSSIA: A MOS, F SEV, F STP/SOUTH, A WAR','TURKEY: F ANK, A CON, A SMY',
  ].join('\n'));
});

test('chosen numbers become legal orders, and every malformed or incomplete answer is refused',async()=>{
  const j = await job('tunis-expedition'), decisions: Record<string,unknown> = {};
  for (const power of j.definition.opponentPowers) {
    const p = lunaPrompt(j,power,await legalFor(j,power),null)!;
    // Take the last listed option for each unit: supports and moves, not just holds.
    decisions[power] = p.set.toAction(p.set.groups.map(g => g.choices.at(-1)!));
    assert.equal(p.set.toAction(holds(p.set)).phase,'ORDERS');
  }
  await rules.validateDecisions(j,decisions as PhaseJob['decisions'] & object,signal());
  const set = lunaPrompt(j,'FRANCE',await legalFor(j,'FRANCE'),null)!.set, [a,b,c] = set.groups;
  for (const bad of [[],[a.choices[0]],[a.choices[0],a.choices[1],c.choices[0]],[a.choices[0],b.choices[0],c.choices[0],c.choices[1]],[a.choices[0],a.choices[0],b.choices[0]],
    [a.choices[0],b.choices[0],set.choices.length],[a.choices[0],b.choices[0],-1],[a.choices[0],b.choices[0],1.5]])
    assert.throws(() => set.toAction(bad as number[]),ChoiceError,JSON.stringify(bad));
  assert.deepEqual(parseChoices({ choices: [0,3,9] }),[0,3,9]);
  for (const bad of [null,[],'{"choices":[1]}',{ choices: '1' },{ choices: [1], extra: true },{ choices: [1.5] },{ choices: [-1] },{ choices: ['1'] },{ choices: Array(35).fill(0) },{ orders: [1] },{}])
    assert.throws(() => parseChoices(bad),ChoiceError,JSON.stringify(bad));
});

test('coasts, supports and convoys from the rules engine survive the catalog and stay legal',async()=>{
  for (const [name,human] of [['split-coast','TURKEY'],['allied-convoy','TURKEY'],['supported-attack','TURKEY'],['circular-moves','TURKEY']] as const) {
    const j = await job(name,human);
    for (const power of j.definition.opponentPowers) {
      const legal = await legalFor(j,power), p = lunaPrompt(j,power,legal,null);
      if (!j.board.units.some(u => u.power === power)) { assert.equal(p,null,`${name} ${power}`); continue; }
      assert.ok(p,`${name} ${power}`);
      assert.equal(p.measured.listed,legal.length,`${name} ${power}`);
      // Every combination of first and last options is a legal submission.
      for (const pick of [p.set.groups.map(g => g.choices[0]),p.set.groups.map(g => g.choices.at(-1)!)])
        await rules.validate(j.board,power,p.set.toAction(pick),signal());
    }
  }
  const convoy = await job('allied-convoy','TURKEY'), english = lunaPrompt(convoy,'ENGLAND',await legalFor(convoy,'ENGLAND'),null)!;
  assert.ok(english.set.choices.some(c => /convoy/i.test(c.label)));
});

test('retreats and adjustments are offered only to powers that must act, and their choices validate',async()=>{
  const retreat = await job('retreat-position','FRANCE'), acting = retreat.board.units.filter(u => u.mustRetreat).map(u => u.power);
  assert.ok(acting.length > 0);
  for (const power of ALL_POWERS) {
    const set = retreatChoices(retreat.board,power);
    if (!acting.includes(power)) { assert.equal(set,null,power); continue; }
    assert.equal(set!.choices[0].label,'disband');assert.ok(set!.choices.length > 1);
    for (const pick of [[set!.groups[0].choices[0]],[set!.groups[0].choices.at(-1)!]]) await rules.validate(retreat.board,power,set!.toAction(pick),signal());
    assert.throws(() => set!.toAction([]),ChoiceError);assert.throws(() => set!.toAction(set!.groups[0].choices.slice(0,2)),ChoiceError);
    if (retreat.definition.opponentPowers.includes(power)) assert.match(lunaPrompt(retreat,power,[],null)!.context,/dislodged/);
  }
  assert.deepEqual(forcedAction(retreat.board),{ phase: 'RETREATS', retreats: {} });
  const winter = await job('winter-build','TURKEY');
  let builders = 0;
  for (const power of ALL_POWERS) {
    const set = buildChoices(winter.board,power);
    if (!set) { await rules.validate(winter.board,power,forcedAction(winter.board),signal()); continue; }
    builders++;
    // Waiving, one build, and a fleet where the coast allows one are all accepted by the engine.
    await rules.validate(winter.board,power,set.toAction([]),signal());
    for (const group of set.groups) for (const i of group.choices) await rules.validate(winter.board,power,set.toAction([i]),signal());
    assert.throws(() => set.toAction(set.groups[0].choices.slice(0,2)),ChoiceError);
  }
  assert.ok(builders > 0);
  // A power with more units than centers must name exactly that many disbands.
  const short = structuredClone(winter.board), victim = short.units[0].power;
  for (const t of TERRITORIES) if (short.territoryOwners[t.id] === victim) short.territoryOwners[t.id] = null;
  const disband = buildChoices(short,victim)!, need = short.units.filter(u => u.power === victim).length;
  assert.match(disband.rule,new RegExp(`exactly ${need} `));
  assert.deepEqual(disband.toAction(disband.choices.map((_,i) => i)).phase,'BUILDS');
  assert.throws(() => disband.toAction([]),ChoiceError);
});

test('an oversized catalog is reduced in a fixed, reported order that always keeps a legal answer, or is refused',async()=>{
  const j = await job('tunis-expedition'), legal = await legalFor(j,'FRANCE');
  // 1,500 extra support options per unit: far beyond the byte limit.
  const flood: LegalOption[] = legal.flatMap(o => o.order.type !== 'HOLD' ? [] : Array.from({ length: 1500 },(_,i) => ({ ...o, id: `${o.unitTerritory}|SUPPORT_HOLD|X${i}`,
    order: { ...o.order, id: `${o.unitTerritory}|SUPPORT_HOLD|X${i}`, type: 'SUPPORT_HOLD' as const }, description: `${o.unitTerritory} supports imaginary unit number ${i}` })));
  const big = [...legal,...flood], p = lunaPrompt(j,'FRANCE',big,null)!;
  assert.equal(p.measured.compacted,true);assert.equal(p.measured.total,big.length);assert.ok(p.measured.listed < big.length && p.measured.listed >= legal.length);
  assert.ok(p.measured.contextBytes <= LUNA_PRESET.maxContextBytes && p.measured.requestBytes <= LUNA_PRESET.maxRequestBytes);
  // Real moves are kept ahead of supports, and every unit still starts with its hold.
  for (const group of p.set.groups) assert.match(p.set.choices[group.choices[0]].label,/hold/i);
  for (const option of legal.filter(o => o.order.type === 'MOVE')) assert.ok(p.context.includes(option.description),option.description);
  await rules.validate(j.board,'FRANCE',p.set.toAction(holds(p.set)),signal());
  assert.equal(lunaPrompt(j,'FRANCE',big,null)!.request.requestHash,p.request.requestHash);
  // If even one hold per unit cannot fit, nothing is sent.
  const impossible = legal.map(o => ({ ...o, description: o.order.type === 'HOLD' ? 'h'.repeat(9_000) : o.description }));
  assert.throws(() => lunaPrompt(j,'FRANCE',impossible,null),/cannot be described/);
  assert.throws(() => orderChoices(j.board,'FRANCE',legal.filter(o => o.order.type !== 'HOLD')),/No legal HOLD/);
});

test('recent public results are included when they fit and are the first thing dropped',async()=>{
  const j = await job('tunis-expedition'), legal = await legalFor(j,'FRANCE');
  const report = { id: 'r', sequence: 1, year: 1900, season: 'FALL' as const, phase: 'ORDERS' as const, resolvedAt: '', before: j.board, after: j.board, standoffTerritories: [], dislodgedUnits: [], destroyedUnits: [], ownershipChanges: [],
    resolvedOrders: Array.from({ length: 60 },(_,i) => ({ id: `PUBLIC-RESULT-${String(i).padStart(2,'0')}`, power: 'ITALY' as const, unitTerritory: 'ROM', unitCoast: null, type: 'HOLD' as const, targetTerritory: null, targetCoast: null, supportedUnit: null, supportedDestination: null, resolution: 'SUCCEEDS' as const, reason: null })) };
  const withRecent = lunaPrompt(j,'FRANCE',legal,report as never)!;
  assert.match(withRecent.context,/Previous phase \(FALL 1900 ORDERS\), public results:/);
  // Bounded to forty lines however long the previous phase was.
  assert.equal(withRecent.context.match(/PUBLIC-RESULT-/g)!.length,40);
  assert.equal(withRecent.measured.compacted,false);
  const flood: LegalOption[] = legal.flatMap(o => o.order.type !== 'HOLD' ? [] : Array.from({ length: 1500 },(_,i) => ({ ...o, id: `${o.unitTerritory}|X${i}`, order: { ...o.order, type: 'SUPPORT_HOLD' as const }, description: `${o.unitTerritory} supports imaginary unit number ${i}` })));
  const tight = lunaPrompt(j,'FRANCE',[...legal,...flood],report as never)!;
  assert.equal(tight.measured.recentLines,0);assert.ok(!tight.context.includes('PUBLIC-RESULT-'));
});


test('scripted adjustment indices respect build delta rather than the number of empty home centers',async()=>{
  const winter=await job('winter-build','TURKEY'),board=structuredClone(winter.board);
  // Three centers, two armies, but two empty homes: only one build is allowed.
  board.units.find(u=>u.power==='FRANCE'&&u.territory==='MAR')!.territory='BUR';
  const set=buildChoices(board,'FRANCE')!;assert.equal(set.groups.length,2);
  assert.throws(()=>set.toAction(set.groups.map(g=>g.choices[0])),ChoiceError);
  assert.equal(set.defaultIndices.length,1);
  const action=set.toAction(set.defaultIndices);assert.equal(action.phase,'BUILDS');
  assert.ok(action.phase==='BUILDS'&&action.builds.length===1&&action.disbands.length===0);
  await rules.validate(board,'FRANCE',action,signal());
  // The algorithm does not parse presentation copy for selection counts.
  set.rule='Translated display text';await rules.validate(board,'FRANCE',set.toAction(set.defaultIndices),signal());
  await rules.validate(board,'FRANCE',set.toAction([]),signal());
  board.territoryOwners.BRE=null;assert.equal(buildChoices(board,'FRANCE'),null,'zero adjustment');
  board.territoryOwners.MAR=null;
  const disband=buildChoices(board,'FRANCE')!;assert.equal(disband.defaultIndices.length,1);
  await rules.validate(board,'FRANCE',disband.toAction(disband.defaultIndices),signal());
  board.territoryOwners.PAR=null;
  const all=buildChoices(board,'FRANCE')!;assert.equal(all.defaultIndices.length,2);
  await rules.validate(board,'FRANCE',all.toAction(all.defaultIndices),signal());
});
