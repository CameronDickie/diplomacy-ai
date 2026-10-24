import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AutoplayGameFile } from '@diplomacy/shared';
import { indexEntry, isPublished, mergeGame, publishedGame } from '../autoplay/records.js';

/** A game file reduced to what combining reads: the run, the reported phases and the failures. */
function file(phases: string[], failures: Array<{ at: string; reason: string }>, exportedAt: string, extra: Partial<AutoplayGameFile['run']> = {}): AutoplayGameFile {
  return { run: { runId: 'g', attemptId: 'auto-g', transport: 'live', lastYear: 1999, talkRecipients: 3, assignment: { AUSTRIA: 'gpt-6-luna' } as AutoplayGameFile['run']['assignment'], planId: 'p', contextVersion: 'c',
      harness: { commit: exportedAt.slice(11, 13).repeat(20), modified: false, instructionsHash: 'abc', ordersInstructions: '', callTimeoutMs: 40_000, stalemateYears: 10 }, ...extra },
    status: 'WAITING', endedBy: null, waitingOn: null,
    summary: { phases: phases.length, year: 1901, season: 'FALL', centers: { AUSTRIA: 3 } as AutoplayGameFile['summary']['centers'], winner: null, calls: 0, validCalls: 0, talkCalls: 0, messages: 0, settledNanousd: 0, heldNanousd: 0, peakInputTokens: { orders: 0, ask: 0, reply: 0 } },
    record: { exportedAt, note: '', attempt: {} as AutoplayGameFile['record']['attempt'], opponents: {}, chat: [], models: {},
      phases: [...phases.map(phaseId => ({ phaseId, report: {} as never, calls: [] })), { phaseId: 'waiting', report: null, calls: [] }],
      failures: failures.map(f => ({ ...f, phaseId: 'x' })) } };
}

test('one game\'s files combine into the furthest one, with every run\'s failures in time order, and nothing else is combined',() => {
  const a = file(['p1','p2'],[{ at: '2026-10-13T10:00:00Z', reason: 'first run' }],'2026-10-13T10:05:00Z');
  const b = file(['p1','p2','p3'],[{ at: '2026-10-13T11:00:00Z', reason: 'second run' }],'2026-10-13T11:05:00Z');
  const merged = mergeGame([{ file: 'later.json', game: b },{ file: 'earlier.json', game: a }]);
  assert.deepEqual(merged.record.phases.map(p => p.phaseId),['p1','p2','p3','waiting']);
  assert.deepEqual(merged.record.failures.map(f => f.reason),['first run','second run']);
  assert.deepEqual(merged.parts!.map(p => [p.file,p.failures]),[['earlier.json',1],['later.json',1]]);
  // The same file given twice adds nothing.
  assert.equal(mergeGame([{ file: 'a.json', game: a },{ file: 'a-copy.json', game: a }]).record.failures.length,1);
  assert.throws(() => mergeGame([{ file: 'a.json', game: a },{ file: 'other.json', game: file(['p1'],[], '2026-10-13T12:00:00Z',{ attemptId: 'auto-other', runId: 'other' }) }]),/another game/);
  assert.throws(() => mergeGame([{ file: 'a.json', game: a },{ file: 'b.json', game: file(['p1','q2','p3'],[],'2026-10-13T12:00:00Z') }]),/does not agree/);
  assert.throws(() => mergeGame([{ file: 'a.json', game: a },{ file: 'b.json', game: file(['p1'],[],'2026-10-13T12:00:00Z',{ lastYear: 1950 }) }]),/other models or another last year/);
  assert.throws(() => mergeGame([]),/No files/);
  const entry = indexEntry('g.json',123,merged);
  assert.deepEqual([entry.runId,entry.parts,entry.failures,entry.instructionsHashes,entry.commits.length],['g',2,2,['abc'],2]);
  // A record from before the stamp existed is listed without one.
  const old = file(['p1'],[],'2026-10-12T10:00:00Z'); delete old.run.harness;
  assert.deepEqual(indexEntry('old.json',1,old).instructionsHashes,[]);
});

test('a published game keeps what was played and said, and drops the prompt, the commit and the local file names', () => {
  const game = file(['p1'], [{ at: '2026-10-13T10:00:00Z', reason: 'retry' }], '2026-10-13T10:05:00Z');
  game.run.harness!.ordersInstructions = 'SECRET prompt';
  const merged = mergeGame([{ file: 'autoplay-live-9.json', game }]);
  const published = publishedGame(merged);
  assert.equal(published.run.harness!.ordersInstructions, '');
  assert.equal(published.run.harness!.commit, null);
  assert.equal(published.run.harness!.instructionsHash, 'abc');
  assert.deepEqual(published.parts!.map(p => [p.file, p.commit, p.failures]), [['run-1', null, 1]]);
  assert.deepEqual(published.record, merged.record);
  assert.equal(JSON.stringify(published).includes('SECRET') || JSON.stringify(published).includes('autoplay-live-9'), false);
  assert.equal(isPublished(merged), false);
  assert.equal(isPublished(published), true);
});

test('publish rejects identical and symlink-aliased directories without changing private files', async t => {
  const directory = await mkdtemp(join(tmpdir(),'diplomacy-records-'));
  t.after(() => rm(directory,{ recursive: true, force: true }));
  const source = join(directory,'private'), destination = join(directory,'public'), alias = join(directory,'alias');
  await mkdir(source);
  await symlink(source,alias,'dir');
  const originals = new Map<string,string>();
  for (const runId of ['chosen','unselected']) {
    const game = file(['p1'],[],'2026-10-13T10:05:00Z',{ runId, attemptId: `auto-${runId}` });
    game.run.harness!.ordersInstructions = 'SECRET prompt';
    originals.set(`${runId}.json`,JSON.stringify(game));
  }
  originals.set('index.json','{"private":true}\n');
  for (const [name,contents] of originals) await writeFile(join(source,name),contents);
  const cli = fileURLToPath(new URL('../autoplay/recordsCli.js',import.meta.url));
  const publish = (from: string, into: string) => spawnSync(process.execPath,[cli,'publish','--from',from,'--into',into,'chosen'],{ encoding: 'utf8', env: { ...process.env, DIPLOMACY_ENV_FILE: '/dev/null' } });
  for (const [from,into] of [[source,source],[source,join(source,'..','private')],[source,alias],[alias,source]]) {
    const result = publish(from,into);
    assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,/different source and destination directories/);
    assert.deepEqual((await readdir(source)).sort(),[...originals.keys()].sort());
    for (const [name,contents] of originals) assert.equal(await readFile(join(source,name),'utf8'),contents);
  }
  const result = publish(source,destination);
  assert.equal(result.status,0,result.stderr);
  const published = JSON.parse(await readFile(join(destination,'chosen.json'),'utf8')) as AutoplayGameFile;
  assert.equal(published.run.harness!.ordersInstructions,'');
  assert.equal(published.run.harness!.commit,null);
  assert.deepEqual(JSON.parse(await readFile(join(destination,'index.json'),'utf8')).games.map((entry: { runId: string }) => entry.runId),['chosen']);
  for (const [name,contents] of originals) assert.equal(await readFile(join(source,name),'utf8'),contents);
});
