import { ALL_POWERS, TERRITORIES } from '@diplomacy/shared';
import type { Power, PublicPhaseReport } from '@diplomacy/shared';
import type { PhaseJob } from '../attempts/types.js';
import { LUNA_PRESET, buildLunaRequest, lunaReservationNanousd } from '../providers/LunaPreset.js';
import { ChoiceError, buildChoices, orderChoices, retreatChoices, type ChoiceSet, type LegalOption } from './Choices.js';

export const CONTEXT_VERSION = 'luna-context-v1';
/** Recent public results are useful but optional: they are the first thing dropped when space is short. */
const RECENT_LINE_LIMIT = 40;
const unit = (u: PhaseJob['board']['units'][number]) => `${u.type === 'ARMY' ? 'A' : 'F'} ${u.territory}${u.coast ? `/${u.coast}` : ''}${u.mustRetreat ? ' (dislodged)' : ''}`;

/**
 * Everything every opponent may know this phase, identical for all six, so it forms a reusable
 * request prefix. It is built only from the frozen public board, the pinned objective and the last
 * public report. `job.humanAction` and `job.decisions` are never read here.
 */
export function sharedContext(job: Pick<PhaseJob,'board' | 'definition'>, lastReport: PublicPhaseReport | null, recentLines = RECENT_LINE_LIMIT): string {
  const { board, definition: d } = job, lines: string[] = [];
  lines.push(`Diplomacy, standard map. ${board.season} ${board.year}, ${board.phase} phase.`);
  lines.push(`Scenario "${d.title}": ${d.humanPower} is played by a human whose goal is to own ${d.objective.territory} after a Fall turn no later than Fall ${d.objective.deadlineYear}. Every other power is played separately and looks after its own interests.`);
  lines.push('Supply centers:');
  const centers = (owner: Power | null) => TERRITORIES.filter(t => t.isSupplyCenter && (board.territoryOwners[t.id] ?? null) === owner).map(t => t.id).sort().join(' ') || '-';
  for (const power of ALL_POWERS) lines.push(`${power}: ${centers(power)}`);
  lines.push(`Unowned: ${centers(null)}`);
  lines.push('Units:');
  for (const power of ALL_POWERS) lines.push(`${power}: ${board.units.filter(u => u.power === power).sort((a,b) => a.territory.localeCompare(b.territory)).map(unit).join(', ') || '-'}`);
  if (lastReport && recentLines > 0) {
    const recent = lastReport.phase === 'ORDERS' ? lastReport.resolvedOrders.map(o => `${o.power} ${o.id} ${o.resolution}`)
      : lastReport.phase === 'RETREATS' ? lastReport.retreats.map(r => `${r.power} ${r.fromTerritory} ${r.outcome}${r.toTerritory ? ` ${r.toTerritory}` : ''}`)
      : lastReport.adjustments.flatMap(a => [...a.builds.map(b => `${a.power} built ${b.type} ${b.territory}`), ...a.disbandedUnits.map(u => `${a.power} disbanded ${u.territory}`)]);
    if (recent.length) { lines.push(`Previous phase (${lastReport.season} ${lastReport.year} ${lastReport.phase}), public results:`); lines.push(...recent.sort().slice(0,recentLines)); }
  }
  return lines.join('\n');
}
function ownSection(set: ChoiceSet): string {
  const lines = [`You are ${set.power}. ${set.rule}`];
  for (const group of set.groups) { lines.push(`${group.label}:`); for (const i of group.choices) lines.push(`${i} ${set.choices[i].label}`); }
  lines.push('Answer with {"choices":[...]} using only numbers listed above.');
  return lines.join('\n');
}
export interface LunaPrompt {
  power: Power;
  set: ChoiceSet;
  context: string;
  /** Exact serialized request and its hash, as reserved and sent. */
  request: ReturnType<typeof buildLunaRequest>;
  /** Reserve the entire accepted token ceiling; bytes do not prove a model token bound. */
  maxCostNanousd: number;
  measured: { contextBytes: number; requestBytes: number; sharedBytes: number; listed: number; total: number; recentLines: number; compacted: boolean };
}

/**
 * Builds one power's request, or returns null when that power has nothing to decide.
 * If the full text does not fit the preset it is reduced in a fixed order — recent results first,
 * then each unit's SUPPORT/CONVOY options from the end of its list — and the reduction is reported
 * in `measured`. A unit's HOLD is never removed. If it still does not fit, this throws.
 */
export function lunaPrompt(job: Pick<PhaseJob,'board' | 'definition'>, power: Power, legal: readonly LegalOption[], lastReport: PublicPhaseReport | null): LunaPrompt | null {
  if (!job.definition.opponentPowers.includes(power)) throw new ChoiceError('Only an opponent power is prompted.');
  const build = (keep: number) => job.board.phase === 'ORDERS' ? orderChoices(job.board,power,legal,keep) : job.board.phase === 'RETREATS' ? retreatChoices(job.board,power) : buildChoices(job.board,power);
  const full = build(Number.MAX_SAFE_INTEGER);
  if (!full) return null;
  const widest = Math.max(...full.groups.map(g => g.choices.length));
  // Candidate shapes, most informative first.
  const shapes: Array<{ recent: number; keep: number }> = [{ recent: RECENT_LINE_LIMIT, keep: Number.MAX_SAFE_INTEGER }, { recent: 0, keep: Number.MAX_SAFE_INTEGER }];
  if (job.board.phase === 'ORDERS') for (let keep = widest - 1; keep >= 1; keep = keep > 16 ? Math.floor(keep * 0.75) : keep - 1) shapes.push({ recent: 0, keep });
  for (const shape of shapes) {
    const set = shape.keep === Number.MAX_SAFE_INTEGER ? full : build(shape.keep)!;
    // The schema allows at most 34 indices and index values up to 100,000.
    if (set.groups.length > 34 || set.choices.length > 100_000) break;
    const shared = sharedContext(job,lastReport,shape.recent), context = `${shared}\n\n${ownSection(set)}`;
    const contextBytes = Buffer.byteLength(context,'utf8');
    if (contextBytes > LUNA_PRESET.maxContextBytes) continue;
    const request = buildLunaRequest({ context }), requestBytes = Buffer.byteLength(request.body,'utf8');
    if (requestBytes > LUNA_PRESET.maxRequestBytes) continue;
    return { power, set, context, request, maxCostNanousd: lunaReservationNanousd(LUNA_PRESET.maxInputTokens),
      measured: { contextBytes, requestBytes, sharedBytes: Buffer.byteLength(shared,'utf8'), listed: set.coverage.listed, total: set.coverage.total, recentLines: shape.recent, compacted: shape !== shapes[0] } };
  }
  throw new ChoiceError('This position cannot be described within the request limits.');
}
