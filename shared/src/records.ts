import type { AutoplayGameFile } from './types/autoplay.js';

type Phase = AutoplayGameFile['record']['phases'][number];
type Report = NonNullable<Phase['report']>;

/**
 * A game record stores every board twice: each reported phase's `before` is the previous reported phase's
 * `after`. A compact record, for a static copy of the viewer where every byte is downloaded, keeps only the
 * first `before`; expandGame puts the rest back. Refuses a record whose phases do not follow on.
 */
export function compactGame(game: AutoplayGameFile): AutoplayGameFile {
  if (game.compact) return game;
  let previous: Report | null = null;
  const phases = game.record.phases.map(p => {
    if (!p.report) return p;
    const last = previous;
    previous = p.report;
    if (!last) return p;
    if (JSON.stringify(last.after) !== JSON.stringify(p.report.before)) throw new Error(`${game.run.runId}: ${p.phaseId} does not start from the previous phase's board.`);
    const { before: _before, ...report } = p.report;
    return { ...p, report: report as Report };
  });
  return { ...game, compact: true, record: { ...game.record, phases } };
}

/** A record as the viewer reads it: a compact one with every board put back, anything else unchanged. */
export function expandGame(game: AutoplayGameFile): AutoplayGameFile {
  if (!game.compact) return game;
  let previous: Report | null = null;
  const phases = game.record.phases.map(p => {
    if (!p.report) return p;
    const before = (p.report as Partial<Report>).before ?? previous?.after;
    if (!before) throw new Error(`${game.run.runId}: ${p.phaseId} has no board to start from.`);
    previous = p.report;
    return { ...p, report: { ...p.report, before } };
  });
  const { compact: _compact, ...rest } = game;
  return { ...rest, record: { ...game.record, phases } };
}
