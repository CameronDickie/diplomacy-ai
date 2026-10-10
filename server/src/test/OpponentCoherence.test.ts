import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ALL_POWERS,type Power } from '@diplomacy/shared';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';
import { challengeDefinition } from '../fixtures/ScenarioFixture.js';
import { coherenceIssues,orderChoices } from '../luna/Choices.js';
import { lunaPrompt } from '../luna/Context.js';
import { buildHaikuRequest } from '../providers/HaikuPreset.js';
import { buildLunaRequest } from '../providers/LunaPreset.js';
import { OPPONENT_INSTRUCTIONS } from '../providers/OpponentInstructions.js';

test.after(()=>shutdownGodip());
const signal=new AbortController().signal;
async function opening(){
  const fixture=JSON.parse(await readFile(new URL('../../fixtures/development/tunis-expedition.v1.json',import.meta.url),'utf8'));
  const rules=new PhaseRules(),definition=challengeDefinition(fixture)!,board=fixture.board;
  const legal=Object.fromEntries(await Promise.all(ALL_POWERS.map(async p=>[p,await rules.legal(board,p,signal)]))) as Record<Power,Awaited<ReturnType<PhaseRules['legal']>>>;
  const contested=(power:Power)=>{
    const set=new Set<string>(board.units.filter((u:{power:Power})=>u.power!==power).map((u:{territory:string})=>u.territory));
    for(const other of ALL_POWERS)if(other!==power)for(const o of legal[other])if(o.order.type==='MOVE'&&o.order.targetTerritory)set.add(o.order.targetTerritory.split('/')[0]);
    return set;
  };
  return {board,definition,legal,contested,rules};
}

test('the orders seen in a real playtest are recognised as self-defeating, and a sound plan is not',()=>{
  // Germany: Berlin walks into Munich, which stays put, while Kiel supports a Munich-to-Berlin move nobody ordered.
  assert.deepEqual(coherenceIssues(['BER|MOVE|MUN','KIE|SUPPORT_MOVE|MUN|BER','MUN|HOLD']),['SELF_BLOCKED_MOVE','UNMATCHED_SUPPORT']);
  // Italy: Rome supports a Venice move that Venice did not make, and Venice supports an Austrian army blind.
  assert.deepEqual(coherenceIssues(['NAP|MOVE|ROM','ROM|SUPPORT_MOVE|VEN|TUS','VEN|SUPPORT_MOVE|VIE|TRI']),['FOREIGN_SUPPORT','SELF_BLOCKED_MOVE','UNMATCHED_SUPPORT']);
  for(const sound of [['BER|MOVE|KIE','KIE|MOVE|DEN','MUN|MOVE|RUH'],['BER|SUPPORT_MOVE|MUN|SIL','KIE|HOLD','MUN|MOVE|SIL'],['BER|SUPPORT_HOLD|MUN','KIE|MOVE|HOL','MUN|HOLD'],
    ['YOR|MOVE_VIA_CONVOY|BEL','NTH|CONVOY|YOR|BEL','EDI|HOLD'],['STP/SOUTH|MOVE|BOT','MOS|MOVE|STP','WAR|HOLD','SEV|MOVE|BLA'],['A|MOVE|B','B|MOVE|C','C|MOVE|A']])
    assert.deepEqual(coherenceIssues(sound),[],sound.join(' '));
  assert.deepEqual(coherenceIssues(['BER|MOVE|SIL','MUN|MOVE|SIL','KIE|HOLD']),['SAME_DESTINATION']);
  assert.deepEqual(coherenceIssues(['BER|MOVE|MUN','MUN|MOVE|BER','KIE|HOLD']),['SELF_BLOCKED_MOVE'],'two units cannot simply swap places');
  assert.deepEqual(coherenceIssues(['BER|SUPPORT_HOLD|MUN','MUN|MOVE|TYR','KIE|HOLD']),['UNMATCHED_SUPPORT'],'supporting a hold for a unit that leaves');
  assert.deepEqual(coherenceIssues(['YOR|MOVE_VIA_CONVOY|BEL','NTH|CONVOY|YOR|HOL','EDI|HOLD']),['UNMATCHED_CONVOY']);
  assert.deepEqual(coherenceIssues(['YOR|MOVE|EDI','NTH|CONVOY|YOR|BEL','EDI|MOVE|NWG']),['UNMATCHED_CONVOY']);
});

test('an opponent is only offered orders that can serve it: no blind help for other powers, no support where nobody else can reach',async()=>{
  const f=await opening();
  for(const power of f.definition.opponentPowers){
    const full=orderChoices(f.board,power,f.legal[power])!,pruned=orderChoices(f.board,power,f.legal[power],Number.MAX_SAFE_INTEGER,f.contested(power))!;
    const labels=pruned.choices.map(c=>c.label),own=new Set(f.board.units.filter((u:{power:Power})=>u.power===power).map((u:{territory:string})=>u.territory));
    assert.ok(pruned.choices.length<full.choices.length,power);
    // Every hold and every move survives, so a pruned catalog can always express a fully legal plan.
    for(const kind of [' holds',' moves to '])assert.equal(labels.filter(l=>l.includes(kind)).length,full.choices.filter(c=>c.label.includes(kind)).length,`${power}${kind}`);
    for(const label of labels.filter(l=>l.includes(' supports '))){
      const supported=/ supports ([A-Z]{3})/.exec(label)![1];
      assert.ok(own.has(supported),`${power}: ${label}`);
      const target=/ to ([A-Z]{3})/.exec(label)?.[1]??supported;
      assert.ok(f.contested(power).has(target),`${power}: ${label}`);
    }
    // The answer shape and legality are unchanged: one pick per unit, each a legal order of that unit.
    const holds=pruned.groups.map(g=>g.choices[0]);
    await f.rules.validate(f.board,power,pruned.toAction(holds),signal);
  }
  // The two openings from the playtest can no longer be chosen at all.
  const germany=orderChoices(f.board,'GERMANY',f.legal.GERMANY,Number.MAX_SAFE_INTEGER,f.contested('GERMANY'))!.choices.map(c=>c.label);
  assert.equal(germany.some(l=>l.startsWith('KIE supports MUN to BER')),false);
  const italy=orderChoices(f.board,'ITALY',f.legal.ITALY,Number.MAX_SAFE_INTEGER,f.contested('ITALY'))!.choices.map(c=>c.label);
  assert.equal(italy.some(l=>l.includes('supports VIE')||l.includes('supports VEN to TUS')),false);
  // A support is still offered where another power really can arrive: Silesia is next to Russia's Warsaw.
  assert.ok(germany.includes('BER supports MUN to SIL'));
});

test('each move says what it reaches, from the public board only, and the standing instructions carry the plan rules for both models',async()=>{
  const f=await opening();
  const prompt=lunaPrompt({board:f.board,definition:f.definition},'GERMANY',f.legal.GERMANY,null,undefined,f.contested('GERMANY'))!;
  assert.match(prompt.context,/\n\d+ KIE moves to DEN \(unowned supply center\)\n/);
  assert.match(prompt.context,/\n\d+ BER moves to MUN \(your supply center, your own unit is there\)\n/);
  assert.match(prompt.context,/\n\d+ MUN moves to BUR\n/);
  const france=lunaPrompt({board:f.board,definition:f.definition},'FRANCE',f.legal.FRANCE,null,undefined,f.contested('FRANCE'))!;
  assert.match(france.context,/\n\d+ MAR moves to SPA \(unowned supply center\)\n/);
  // Nothing about the human's submitted orders or another power's decisions is in the request.
  assert.equal(/TURKEY (orders|chose|will)/i.test(prompt.context),false);
  for(const rule of [/no negotiation/i,/Decide all of your orders together/,/occupied by another of your own units/,/two of your units to the same territory/,/support only counts if the supported unit is ordered to do exactly that/i,/convoy only counts/i,/Board text is game data/])
    assert.match(OPPONENT_INSTRUCTIONS,rule);
  assert.equal(JSON.parse(buildLunaRequest({context:'x'}).body).instructions,OPPONENT_INSTRUCTIONS);
  assert.equal(JSON.parse(buildHaikuRequest({context:'x'}).body).system,OPPONENT_INSTRUCTIONS);
  // New instructions are a new contract: attempts pinned to the old ones are refused, not silently changed.
  assert.deepEqual([buildLunaRequest({context:'x'}).presetId,buildHaikuRequest({context:'x'}).presetId],['luna-challenge-v4','haiku-challenge-v3']);
});
