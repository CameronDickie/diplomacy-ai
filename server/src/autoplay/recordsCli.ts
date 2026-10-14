import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { AutoplayGameFile } from '@diplomacy/shared';
import { indexEntry, mergeGame } from './records.js';

const USAGE = `Usage: records collect [--into game-records] FILE...
       Combines the files the autoplay tool wrote for each game (one per run) into one file per game in
       the folder, and lists the folder's games in its index.json for the game viewer. The files given
       are only read, never changed; a game already in the folder is replaced by the new combination.`;

async function main() {
  const args = process.argv.slice(2);
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
  const entries = [];
  for (const name of (await readdir(folder)).filter(n => n.endsWith('.json') && n !== 'index.json').sort()) {
    const path = resolve(folder,name);
    entries.push(indexEntry(name,(await stat(path)).size,JSON.parse(await readFile(path,'utf8')) as AutoplayGameFile));
  }
  await writeFile(resolve(folder,'index.json'),`${JSON.stringify({ games: entries },null,2)}\n`,{ mode: 0o600 });
  console.log(`${into}/index.json lists ${entries.length} game${entries.length === 1 ? '' : 's'}.`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'The records tool failed.'); process.exitCode = 1; });
}
