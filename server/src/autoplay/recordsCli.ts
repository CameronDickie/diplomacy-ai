import { readFile, readdir, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AutoplayGameFile } from '@diplomacy/shared';
import { indexEntry, isPublished, mergeGame, publishedGame } from './records.js';
import { rm } from 'node:fs/promises';

const USAGE = `Usage: records collect [--into game-records] FILE...
       Combines the files the autoplay tool wrote for each game (one per run) into one file per game in
       the folder, and lists the folder's games in its index.json for the game viewer. The files given
       are only read, never changed; a game already in the folder is replaced by the new combination.
       records publish [--from game-records] [--into published-games] RUN_ID...
       Copies the named games, without their prompt, commit or file names, into the folder the server
       serves when DIPLOMACY_PUBLISHED_GAMES_DIR points at it, and rewrites that folder's index.json.
       records withdraw [--into published-games] RUN_ID...
       Removes the named games from the published folder and rewrites its index.json.
       records check [--into published-games]
       Confirms every game in the folder is in published form and listed in its index.json; the
       production publish script runs this before uploading anything.`;
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,55}$/;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'publish') return publish(args.slice(1));
  if (args[0] === 'withdraw') return withdraw(args.slice(1));
  if (args[0] === 'check') return check(args.slice(1));
  if (args[0] !== 'collect') throw new Error(USAGE);
  let into = 'game-records';
  const files: string[] = [];
  for (let i = 1; i < args.length; i++) { if (args[i] === '--into') into = args[++i] ?? ''; else files.push(args[i]); }
  if (!into || !files.length) throw new Error(USAGE);
  const folder = resolve(into);
  const inputs = await Promise.all(files.map(async file => ({ file: basename(file), path: resolve(file), game: JSON.parse(await readFile(file,'utf8')) as AutoplayGameFile })));
  for (const input of inputs) {
    if (!input.game?.run?.attemptId || !Array.isArray(input.game.record?.phases)) throw new Error(`${input.file} is not a game record from the autoplay tool.`);
    if (input.path.startsWith(`${folder}/`)) throw new Error(`${input.file} is already in ${into}; give the tool's original files.`);
  }
  await mkdir(folder,{ recursive: true, mode: 0o700 });
  const games = new Map<string, typeof inputs>();
  for (const input of inputs) games.set(input.game.run.attemptId,[...(games.get(input.game.run.attemptId) ?? []),input]);
  for (const group of games.values()) {
    const merged = mergeGame(group), out = resolve(folder,`${merged.run.runId}.json`);
    // Private game data: readable only by its owner, as the tool's own files are.
    await writeFile(out,`${JSON.stringify(merged)}\n`,{ mode: 0o600 });
    console.log(`${merged.run.runId}: ${group.length} file${group.length === 1 ? '' : 's'} → ${into}/${basename(out)} · ${merged.summary.phases} phases · ${merged.record.failures.length} failures`);
  }
  const count = await writeIndex(folder);
  console.log(`${into}/index.json lists ${count} game${count === 1 ? '' : 's'}.`);
}

/** Only the games named, each chosen by the owner: nothing is published by default. */
async function publish(args: string[]) {
  let from = 'game-records', into = 'published-games';
  const runs: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--from') from = args[++i] ?? ''; else if (args[i] === '--into') into = args[++i] ?? ''; else runs.push(args[i]); }
  if (!from || !into || !runs.length || runs.some(run => !RUN_ID.test(run))) throw new Error(USAGE);
  const folder = resolve(into);
  const source = await realpath(from);
  const destination = await realpath(folder).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (source === destination) throw new Error('Publishing needs different source and destination directories.');
  await mkdir(folder, { recursive: true, mode: 0o755 });
  for (const run of runs) {
    const game = JSON.parse(await readFile(resolve(from, `${run}.json`), 'utf8')) as AutoplayGameFile;
    if (game.run?.runId !== run || !Array.isArray(game.record?.phases)) throw new Error(`${from}/${run}.json is not a combined game record.`);
    // Meant to be read by the web server, so readable rather than owner-only.
    await writeFile(resolve(folder, `${run}.json`), `${JSON.stringify(publishedGame(game))}\n`, { mode: 0o644 });
    console.log(`${run} → ${into}/${run}.json`);
  }
  const count = await writeIndex(folder, 0o644);
  console.log(`${into}/index.json lists ${count} game${count === 1 ? '' : 's'}.`);
}

function publishedFolder(args: string[]): { into: string; runs: string[] } {
  let into = 'published-games';
  const runs: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--into') into = args[++i] ?? ''; else runs.push(args[i]); }
  if (!into || runs.some(run => !RUN_ID.test(run))) throw new Error(USAGE);
  return { into, runs };
}

async function withdraw(args: string[]) {
  const { into, runs } = publishedFolder(args);
  if (!runs.length) throw new Error(USAGE);
  for (const run of runs) { await rm(resolve(into, `${run}.json`)); console.log(`${run} withdrawn from ${into}`); }
  const count = await writeIndex(resolve(into), 0o644);
  console.log(`${into}/index.json lists ${count} game${count === 1 ? '' : 's'}.`);
}

/** Refuses a folder holding anything but published games, or whose index is out of date. */
async function check(args: string[]) {
  const { into, runs } = publishedFolder(args);
  if (runs.length) throw new Error(USAGE);
  const folder = resolve(into), names = (await readdir(folder)).filter(n => n !== 'index.json');
  const strays = names.filter(n => !/^[a-z0-9][a-z0-9-]{0,55}\.json$/.test(n));
  if (strays.length) throw new Error(`${into} holds files the server would not serve: ${strays.join(', ')}`);
  for (const name of names) {
    if (!isPublished(JSON.parse(await readFile(resolve(folder, name), 'utf8')) as AutoplayGameFile)) {
      throw new Error(`${into}/${name} is not in published form (it still has its prompt, commit or file names). Publish it with records publish.`);
    }
  }
  const listed = (JSON.parse(await readFile(resolve(folder, 'index.json'), 'utf8')) as { games: Array<{ file: string }> }).games.map(g => g.file).sort();
  if (JSON.stringify(listed) !== JSON.stringify([...names].sort())) throw new Error(`${into}/index.json does not list exactly the games in the folder; run records publish or withdraw to rewrite it.`);
  console.log(`${into}: ${names.length} published game${names.length === 1 ? '' : 's'}, all in published form.`);
}

/** Lists every game in the folder in its index.json, for the game viewer. */
async function writeIndex(folder: string, mode = 0o600): Promise<number> {
  const entries = [];
  // Number-aware, so live-10 comes after live-9 rather than after live-1.
  for (const name of (await readdir(folder)).filter(n => n.endsWith('.json') && n !== 'index.json').sort((a,b) => a.localeCompare(b,'en',{ numeric: true }))) {
    const path = resolve(folder,name);
    entries.push(indexEntry(name,(await stat(path)).size,JSON.parse(await readFile(path,'utf8')) as AutoplayGameFile));
  }
  await writeFile(resolve(folder,'index.json'),`${JSON.stringify({ games: entries },null,2)}\n`,{ mode });
  return entries.length;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'The records tool failed.'); process.exitCode = 1; });
}
