import type { AutoplayGameFile, AutoplayIndexEntry, AutoplayPart } from '@diplomacy/shared';

/** A reported phase's id, in play order. Only these are compared: a waiting phase has calls but no report. */
const reported = (game: AutoplayGameFile) => game.record.phases.filter(p => p.report).map(p => p.phaseId);
const part = (file: string, game: AutoplayGameFile): AutoplayPart => ({ file, exportedAt: game.record.exportedAt, status: game.status,
  commit: game.run.harness?.commit ?? null, instructionsHash: game.run.harness?.instructionsHash ?? null, failures: game.record.failures.length });

/**
 * One game from the files written by the runs that played it. Every file holds the whole game up to
 * its own export, read from the database; only the list of failures belongs to its own run. So the
 * result is the furthest file, with every file's failures in time order and a list of the files.
 * Files from different games, or that disagree about the turns they share, are refused.
 */
export function mergeGame(files: ReadonlyArray<{ file: string; game: AutoplayGameFile }>): AutoplayGameFile {
  if (!files.length) throw new Error('No files to combine.');
  const first = files[0].game;
  for (const { file, game } of files) {
    if (game.run?.attemptId !== first.run.attemptId) throw new Error(`${file} is from another game (${game.run?.runId}), not ${first.run.runId}.`);
    if (game.run.lastYear !== first.run.lastYear || JSON.stringify(game.run.assignment) !== JSON.stringify(first.run.assignment)) throw new Error(`${file} was played with other models or another last year.`);
  }
  const ordered = [...files].sort((a,b) => a.game.record.exportedAt.localeCompare(b.game.record.exportedAt));
  const latest = ordered.reduce((best,next) => reported(next.game).length >= reported(best.game).length ? next : best);
  const turns = reported(latest.game);
  for (const { file, game } of ordered) {
    const own = reported(game);
    if (own.length > turns.length || own.some((id,i) => id !== turns[i])) throw new Error(`${file} does not agree with ${latest.file} about the turns they share.`);
  }
  const seen = new Set<string>(), failures = ordered.flatMap(f => f.game.record.failures).filter(f => {
    const key = `${f.at}|${f.phaseId}|${f.reason}`; if (seen.has(key)) return false; seen.add(key); return true;
  }).sort((a,b) => a.at.localeCompare(b.at));
  return { ...latest.game, record: { ...latest.game.record, failures }, parts: ordered.map(f => part(f.file,f.game)) };
}

export function indexEntry(file: string, bytes: number, game: AutoplayGameFile): AutoplayIndexEntry {
  const parts = game.parts ?? [part(file,game)];
  return { runId: game.run.runId, file, bytes, transport: game.run.transport, assignment: game.run.assignment, lastYear: game.run.lastYear,
    status: game.status, endedBy: game.endedBy, reached: `${game.summary.season} ${game.summary.year}`, phases: game.summary.phases,
    centers: game.summary.centers, winner: game.summary.winner, settledNanousd: game.summary.settledNanousd, heldNanousd: game.summary.heldNanousd,
    instructionsHashes: [...new Set(parts.map(p => p.instructionsHash).filter((h): h is string => Boolean(h)))],
    commits: [...new Set(parts.map(p => p.commit).filter((c): c is string => Boolean(c)))], parts: parts.length,
    failures: game.record.failures.length, exportedAt: game.record.exportedAt };
}

/**
 * A combined game as it may be shown on the public site: what was played and said, without how it was
 * built. The orders instructions (the prompt) are dropped, keeping their fingerprint; so are the commit
 * and the names of the local files it came from. Orders, messages, notes, calls and costs stay.
 */
export function publishedGame(game: AutoplayGameFile): AutoplayGameFile {
  const harness = game.run.harness && { ...game.run.harness, commit: null, modified: false, ordersInstructions: '' };
  return { ...game, run: { ...game.run, ...(harness ? { harness } : {}) },
    ...(game.parts ? { parts: game.parts.map((p, i) => ({ ...p, file: `run-${i + 1}`, commit: null })) } : {}) };
}

/** Whether a game is in the published form: no prompt, no commit, no local file names. */
export function isPublished(game: AutoplayGameFile): boolean {
  const harness = game.run?.harness;
  return (!harness || (harness.ordersInstructions === '' && harness.commit === null))
    && (game.parts ?? []).every((p, i) => p.file === `run-${i + 1}` && p.commit === null);
}
