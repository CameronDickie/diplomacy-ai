import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { GameRoom } from '../GameRoom.js';
import { boardHash, canonicalJson, exportBoard, importBoard, parseBoard } from '../fixtures/BoardFixture.js';
import { challengeDefinition, importScenario, playWitness } from '../fixtures/ScenarioFixture.js';
import { TUNIS_PILOT_V1 } from '../challenge/TunisPilot.js';

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/development');
const read = (name: string) => JSON.parse(readFileSync(resolve(fixtureDirectory, `${name}.v1.json`), 'utf8'));

test('all versioned fixtures import, export and reconstruct the same rules-only board', async () => {
  for (const file of readdirSync(fixtureDirectory).filter(f => f.endsWith('.json'))) {
    const scenario = await importScenario(JSON.parse(readFileSync(resolve(fixtureDirectory, file), 'utf8')));
    const board = await importBoard(scenario.board);
    const room = await GameRoom.fromBoardFixture(board);
    try {
      const exported = exportBoard(room.getState());
      assert.deepEqual(exported, board, file);
      assert.equal(canonicalJson(await importBoard(JSON.parse(canonicalJson(exported)))), canonicalJson(board));
      assert.equal(boardHash(exported), boardHash(board));
      assert.equal(room.getState().players.length, 0);
      assert.equal(room.getState().status, 'LOBBY');
      assert.equal(room.getPhaseHistory().length, 0);
      assert.ok(!canonicalJson(exported).includes('hostPlayerId'));
    } finally { room.dispose(); }
  }
});

test('each authored witness executes twice with identical boards, hashes and scoring', async () => {
  for (const file of readdirSync(fixtureDirectory).filter(f => f.endsWith('.json'))) {
    const scenario = await importScenario(JSON.parse(readFileSync(resolve(fixtureDirectory, file), 'utf8')));
    for (const witness of scenario.witnesses) {
      const first = await playWitness(scenario, witness.name);
      const second = await playWitness(scenario, witness.name);
      assert.deepEqual(first, second, `${file}/${witness.name}`);
      if (scenario.id === 'split-coast') assert.equal(first.board.units[0].coast, witness.name === 'north-coast' ? 'NORTH' : 'SOUTH');
      if (scenario.id === 'retreat-position') assert.equal(first.board.units.find(u => u.id === 'german-defender')?.territory, 'GAS');
      if (scenario.id === 'supported-attack') assert.deepEqual(first.board, (await importScenario(read('retreat-position'))).board);
      if (scenario.id === 'winter-build') assert.ok(first.board.units.some(u => u.type === 'FLEET' && u.territory === 'BRE'));
      if (witness.name === 'early-capture') assert.deepEqual(first.score?.achievementIds, ['EARLY_CAPTURE']);
    }
  }
});

test('strict schema rejects impossible units, duplicate occupancy, metadata and private/session fields before creation', async () => {
  const original = read('tunis-expedition').board;
  const cases: Array<[string, (value: any) => void, RegExp]> = [
    ['version', b => b.schemaVersion = 2, /schemaVersion/],
    ['variant', b => b.variant = 'CUSTOM', /variant/],
    ['unknown', b => b.sessionToken = 'private-value', /unknown field/],
    ['power', b => b.powers.pop(), /seven/],
    ['province', b => b.units[0].territory = 'MOON', /province/],
    ['army sea', b => { b.units[0].type = 'ARMY'; b.units[0].territory = 'NTH'; }, /army requires land/],
    ['fleet inland', b => { b.units[0].type = 'FLEET'; b.units[0].territory = 'PAR'; }, /fleet requires/],
    ['fleet coast', b => { b.units[0].type = 'FLEET'; b.units[0].territory = 'SPA'; b.units[0].coast = null; }, /explicit coast/],
    ['wrong coast', b => { b.units[0].type = 'FLEET'; b.units[0].territory = 'BUL'; b.units[0].coast = 'NORTH'; }, /valid explicit coast/],
    ['occupancy', b => { b.units.push({...b.units[0],id:'duplicate'}); }, /duplicate values/],
    ['unit id', b => b.units[1].id = b.units[0].id, /duplicate values/],
    ['owner', b => b.territoryOwners.NTH = 'ENGLAND', /cannot be owned/],
    ['missing center', b => delete b.territoryOwners.TUN, /required field/],
    ['winter orders', b => b.season = 'WINTER', /phase/],
    ['empty retreats', b => b.phase = 'RETREATS', /retreating unit/],
    ['stale retreats', b => b.units[0].retreatOptions = ['PAR'], /retreat metadata/],
  ];
  const existing = new GameRoom();
  const untouched = structuredClone(existing.getState());
  for (const [name, mutate, diagnostic] of cases) {
    const invalid = structuredClone(original); mutate(invalid);
    await assert.rejects(GameRoom.fromBoardFixture(invalid), diagnostic, name);
  }
  assert.deepEqual(existing.getState(), untouched, 'imports never mutate an existing room');
  const withSecret = structuredClone(original); withSecret.secret = 'DO-NOT-ECHO';
  assert.throws(() => parseBoard(withSecret), error => !(error as Error).message.includes('DO-NOT-ECHO'));
  existing.dispose();
});

test('Godip rejects invented legal retreats and inconsistent dislodger/bounce context', async () => {
  const original = read('retreat-position').board;
  const invalid = structuredClone(original);
  invalid.units.find((u: any) => u.mustRetreat).retreatOptions = ['PAR'];
  await assert.rejects(importBoard(invalid), /Godip:.*retreatOptions/);
  const missingAttacker = structuredClone(original);
  missingAttacker.retreatContext.dislodgers = {};
  await assert.rejects(importBoard(missingAttacker), /Godip:.*dislodgedBy/);
  const noOccupant = structuredClone(original);
  noOccupant.units = noOccupant.units.filter((u: any) => u.mustRetreat || u.territory !== 'BUR');
  await assert.rejects(importBoard(noOccupant), /enemy occupying/);
  const badBounce = structuredClone(original);
  badBounce.retreatContext.bounces.GAS = [];
  await assert.rejects(importBoard(badBounce), /empty sources/);
  const bounced = structuredClone(original);
  bounced.retreatContext.bounces.GAS = ['MAR', 'PAR'];
  bounced.units.find((u: any) => u.mustRetreat).retreatOptions = bounced.units.find((u: any) => u.mustRetreat).retreatOptions.filter((p: string) => p !== 'GAS');
  const restored = await GameRoom.fromBoardFixture(bounced);
  assert.deepEqual(exportBoard(restored.getState()), await importBoard(bounced), 'all bounce source provinces survive round trip');
  restored.dispose();
});

test('deterministic builds cannot duplicate an imported unit id', async () => {
  const input = read('winter-build');
  input.board.units[0].id = 'build-1901-FRANCE-BRE';
  const scenario = await importScenario(input);
  const result = await playWitness(scenario, 'build-brest');
  assert.equal(new Set(result.board.units.map(u => u.id)).size, result.board.units.length);
  assert.equal(result.board.units.find(u => u.territory === 'BRE')?.id, 'build-1901-FRANCE-BRE-1');
});

test('Tunis pilot references the portable fixture and shares its objective/version', async () => {
  const scenario = await importScenario(read('tunis-expedition'));
  const definition = challengeDefinition(scenario)!;
  assert.deepEqual(TUNIS_PILOT_V1.startingPosition, {fixtureId: scenario.id, version: scenario.version});
  assert.deepEqual(definition.objective, TUNIS_PILOT_V1.objective);
  assert.equal(definition.humanPower, TUNIS_PILOT_V1.humanPower);
  assert.equal(definition.earlyAchievementYear, TUNIS_PILOT_V1.earlyAchievementYear);
  const illegal = structuredClone(scenario);
  illegal.witnesses[0].steps = [{year:1901, season:'SPRING', phase:'ORDERS', orders:['ANK|MOVE|TUN']}];
  await assert.rejects(playWitness(illegal, 'early-capture'), /illegal order ID/);
});

test('offline CLI validates and round-trips without credentials and refuses to overwrite files', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'diplomacy-fixture-cli-'));
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/cli.js');
  const file = resolve(fixtureDirectory, 'retreat-position.v1.json');
  const options = { env: { PATH: process.env.PATH }, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  try {
    assert.equal(JSON.parse(execFileSync(process.execPath, [cli, 'validate', file], options)).valid, true);
    const destination = resolve(dir, 'copy.json');
    execFileSync(process.execPath, [cli, 'roundtrip', file, destination], options);
    assert.equal(readFileSync(destination, 'utf8'), readFileSync(file, 'utf8'));
    assert.throws(() => execFileSync(process.execPath, [cli, 'roundtrip', file, destination], options));
    assert.throws(() => execFileSync(process.execPath, [cli, 'roundtrip', file, file], options));
    const resultFile = resolve(dir, 'after.json');
    execFileSync(process.execPath, [cli, 'play', file, 'retreat-to-gascony', resultFile], options);
    assert.equal(JSON.parse(execFileSync(process.execPath, [cli, 'validate', resultFile], options)).valid, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
