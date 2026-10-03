import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boardHash, canonicalJson, importBoard } from './BoardFixture.js';
import { importScenario, playWitness } from './ScenarioFixture.js';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';

async function main() {
  const [command, file, argument, output] = process.argv.slice(2);
  if (!file || !['validate', 'roundtrip', 'play'].includes(command)) throw new Error('Usage: fixture validate FILE | fixture roundtrip FILE OUTPUT | fixture play FILE WITNESS [OUTPUT]');
  if (statSync(file).size > 1024 * 1024) throw new Error('Fixture input exceeds 1 MiB');
  const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const scenario = input && typeof input === 'object' && Object.hasOwn(input, 'board') ? await importScenario(input) : null;
  const board = scenario?.board ?? await importBoard(input);
  let result: unknown;
  let destination: string | undefined;
  if (command === 'validate') result = { valid: true, boardHash: boardHash(board), ...(scenario ? { fixtureId: scenario.id, witnesses: scenario.witnesses.map(w => w.name) } : {}) };
  else if (command === 'roundtrip') {
    if (!argument) throw new Error('roundtrip requires an output path');
    result = scenario ?? board; destination = argument;
  } else {
    if (!scenario || !argument) throw new Error('play requires a scenario fixture and witness name');
    result = await playWitness(scenario, argument); destination = output;
  }
  if (destination) {
    if (resolve(destination) === resolve(file)) throw new Error('Refusing to overwrite the input fixture');
    // Exclusive creation also protects an existing file reached via a symlink.
    const saved = command === 'play' ? (result as Awaited<ReturnType<typeof playWitness>>).board : result;
    writeFileSync(destination, canonicalJson(saved), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ written: resolve(destination), ...(command === 'play' ? { score: (result as Awaited<ReturnType<typeof playWitness>>).score } : {}) }));
  } else process.stdout.write(canonicalJson(result));
}
try { await main(); } catch (error) {
  console.error(error instanceof Error ? error.message : 'Fixture operation failed');
  process.exitCode = 1;
} finally { await shutdownGodip(); }
