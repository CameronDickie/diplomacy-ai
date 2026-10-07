import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { importScenario, playWitness } from '../fixtures/ScenarioFixture.js';
const rules = new PhaseRules();
const fixture = async (name:string) => importScenario(JSON.parse(readFileSync(new URL(`../../fixtures/development/${name}.v1.json`,import.meta.url),'utf8')));
const signal = () => new AbortController().signal;

test('human catalog permits a friendly circular move and resolves all three units',async()=>{
  const f=await fixture('circular-moves');
  const catalog=await rules.legal(f.board,'FRANCE',signal());
  const ids=['PAR|MOVE|BUR','BUR|MOVE|GAS','GAS|MOVE|PAR'];
  for(const id of ids)assert.ok(catalog.some(o=>o.id===id),id);
  await rules.validate(f.board,'FRANCE',{phase:'ORDERS',orderIds:ids},signal());
  const result=await playWitness(f,'cooperate');
  assert.deepEqual(Object.fromEntries(result.board.units.map(u=>[u.id,u.territory])),{paris:'BUR',burgundy:'GAS',gascony:'PAR'});
});

test('human catalog supports an allied convoy and support for the convoyed attack without issuing allied orders',async()=>{
  const f=await fixture('allied-convoy');
  const english=await rules.legal(f.board,'ENGLAND',signal()), french=await rules.legal(f.board,'FRANCE',signal());
  const ids=['LON|MOVE_VIA_CONVOY|BEL','NTH|SUPPORT_MOVE|LON|BEL'];
  for(const id of ids)assert.ok(english.some(o=>o.id===id),id);
  assert.ok(french.some(o=>o.id==='ENG|CONVOY|LON|BEL'));
  assert.ok(english.every(o=>['LON','NTH'].includes(o.unitTerritory)));
  await rules.validate(f.board,'ENGLAND',{phase:'ORDERS',orderIds:ids},signal());
  await assert.rejects(rules.validate(f.board,'ENGLAND',{phase:'ORDERS',orderIds:[...ids,'ENG|CONVOY|LON|BEL']},signal()),{code:'STORE_INVALID'});
  const result=await playWitness(f,'cooperate');
  assert.equal(result.board.units.find(u=>u.id==='landing')?.territory,'BEL');
  assert.equal(result.board.units.find(u=>u.id==='defender')?.mustRetreat,true);
  assert.equal(result.board.units.find(u=>u.id==='defender')?.dislodgedBy,null);
  assert.deepEqual(result.board.retreatContext?.dislodgers,{});
});

test('human catalog preserves distinct split-coast selections through validation',async()=>{
  const f=await fixture('split-coast'),catalog=await rules.legal(f.board,'ENGLAND',signal());
  for(const coast of ['NORTH','SOUTH']){
    const id=`MAO|MOVE|SPA/${coast}`;assert.ok(catalog.some(o=>o.id===id));
    await rules.validate(f.board,'ENGLAND',{phase:'ORDERS',orderIds:[id]},signal());
  }
  await assert.rejects(rules.validate(f.board,'ENGLAND',{phase:'ORDERS',orderIds:['MAO|MOVE|SPA']},signal()),{code:'STORE_INVALID'});
});
