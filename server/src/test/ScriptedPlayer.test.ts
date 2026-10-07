import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {importScenario} from '../fixtures/ScenarioFixture.js';
import {PhaseRules} from '../attempts/PhaseRules.js';
import {scriptedHumanAction} from '../evaluation/ScriptedPlayer.js';

test('the scripted human submits legal limited builds, exact disbands, and waived adjustments',async()=>{
  const fixture=await importScenario(JSON.parse(await readFile(new URL('../../fixtures/development/winter-build.v1.json',import.meta.url),'utf8')));
  const board=structuredClone(fixture.board),rules=new PhaseRules();
  board.units.find(u=>u.power==='FRANCE'&&u.territory==='MAR')!.territory='BUR';
  const pick=async()=>{
    const action=await scriptedHumanAction(rules,board,'FRANCE',fixture,'unused');
    await rules.validate(board,'FRANCE',action,new AbortController().signal);
    assert.equal(action.phase,'BUILDS');if(action.phase!=='BUILDS')throw new Error('Expected adjustments');return action;
  };
  const build=await pick();assert.equal(build.builds.length,1);assert.equal(build.disbands.length,0);
  board.territoryOwners.BRE=null;assert.deepEqual(await pick(),{phase:'BUILDS',builds:[],disbands:[]});
  board.territoryOwners.MAR=null;const disband=await pick();assert.equal(disband.builds.length,0);assert.equal(disband.disbands.length,1);
  board.territoryOwners.PAR=null;assert.equal((await pick()).disbands.length,2);
  board.territoryOwners.BRE='FRANCE';board.territoryOwners.MAR='FRANCE';board.territoryOwners.PAR='FRANCE';
  board.units[0].territory='BRE';board.units[1].territory='MAR';
  // Occupied homes plus an unowned/blocked third home: a positive delta can still force a waiver.
  board.territoryOwners.PAR=null;board.territoryOwners.BEL='FRANCE';
  assert.deepEqual(await pick(),{phase:'BUILDS',builds:[],disbands:[]});
});
