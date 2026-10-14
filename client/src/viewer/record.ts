import { ALL_POWERS, TERRITORIES, type AutoplayGameFile, type PlaytestCall, type PlaytestTalkCall, type Power, type PublicPhaseReport } from '@diplomacy/shared';

/** One resolved phase of a recorded game, with what each power was asked, said and chose. */
export interface Turn {
  index: number; phaseId: string; report: PublicPhaseReport; calls: PlaytestCall[]; talk: PlaytestTalkCall[];
  failures: AutoplayGameFile['record']['failures']; centers: Record<Power, number>;
}
const SUPPLY = TERRITORIES.filter(t => t.isSupplyCenter).map(t => t.id);
export const centersOf = (owners: Record<string, string | null>) =>
  Object.fromEntries(ALL_POWERS.map(p => [p, SUPPLY.filter(t => owners[t] === p).length])) as Record<Power, number>;

export function turnsOf(game: AutoplayGameFile): Turn[] {
  const failures = new Map<string, Turn['failures']>();
  for (const f of game.record.failures) failures.set(f.phaseId, [...(failures.get(f.phaseId) ?? []), f]);
  // A phase still waiting has calls but no report, so nothing to show on the board.
  return game.record.phases.filter(p => p.report).map((p, index) => ({ index, phaseId: p.phaseId, report: p.report!, calls: p.calls, talk: p.talk ?? [],
    failures: failures.get(p.phaseId) ?? [], centers: centersOf(p.report!.after.territoryOwners) }));
}

export type ModelKey = 'luna' | 'haiku' | 'other';
export const modelKey = (model: string): ModelKey => /luna/i.test(model) ? 'luna' : /haiku/i.test(model) ? 'haiku' : 'other';
export const MODEL_NAMES: Record<ModelKey, string> = { luna: 'GPT-6 Luna', haiku: 'Claude Haiku 5.5', other: 'Other model' };
export const modelOf = (game: { run: { assignment: Record<Power, string> } }, power: Power): ModelKey => modelKey(game.run.assignment[power] ?? '');

/** Each model's orders by kind, counted from what was actually played. */
export function orderMix(game: AutoplayGameFile, turns: Turn[]) {
  const mix = {} as Record<ModelKey, { total: number; HOLD: number; MOVE: number; SUPPORT: number; CONVOY: number }>;
  for (const turn of turns) {
    if (turn.report.phase !== 'ORDERS') continue;
    for (const order of turn.report.resolvedOrders) {
      const m = mix[modelOf(game, order.power)] ??= { total: 0, HOLD: 0, MOVE: 0, SUPPORT: 0, CONVOY: 0 };
      m.total++;
      m[order.type === 'SUPPORT_HOLD' || order.type === 'SUPPORT_MOVE' ? 'SUPPORT' : order.type === 'CONVOY' ? 'CONVOY' : order.type === 'HOLD' ? 'HOLD' : 'MOVE']++;
    }
  }
  return mix;
}

/** The turn each power lost its last supply center, if it did. */
export function eliminations(turns: Turn[]): Partial<Record<Power, number>> {
  const out: Partial<Record<Power, number>> = {};
  for (const turn of turns) for (const p of ALL_POWERS) if (out[p] === undefined && turn.centers[p] === 0) out[p] = turn.index;
  return out;
}
export const usd = (nanousd: number) => `USD ${(nanousd / 1e9).toFixed(2)}`;
