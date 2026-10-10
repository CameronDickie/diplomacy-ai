import { ADJACENCY, TERRITORIES, TERRITORY_MAP } from '@diplomacy/shared';
import type { Order, Power } from '@diplomacy/shared';
import type { BoardFixture } from '../fixtures/BoardFixture.js';
import type { PhaseAction } from '../attempts/types.js';

export interface LegalOption { id: string; unitTerritory: string; order: Order; description: string }
/** One numbered thing a power may pick. `group` is the unit or build slot it belongs to. */
export interface Choice { group: string; label: string }
export interface ChoiceSet {
  power: Power;
  phase: BoardFixture['phase'];
  /** Human-readable rule for how many to pick; the same rule `toAction` enforces. */
  rule: string;
  groups: Array<{ id: string; label: string; choices: number[] }>;
  choices: Choice[];
  /** Total legal options before any compaction, and how many are listed. */
  coverage: { listed: number; total: number };
  toAction(indices: readonly number[]): PhaseAction;
}
/** A deterministic legal adjustment for scripted play, independent of the display rule. */
export interface AdjustmentChoiceSet extends ChoiceSet {
  defaultIndices: readonly number[];
}
export class ChoiceError extends Error { constructor(message: string) { super(message); this.name = 'ChoiceError'; } }

const unitLabel = (type: string, territory: string, coast: string | null) => `${type === 'ARMY' ? 'A' : 'F'} ${territory}${coast ? `/${coast}` : ''}`;
const adjustment = (board: BoardFixture, power: Power) =>
  TERRITORIES.filter(t => t.isSupplyCenter && board.territoryOwners[t.id] === power).length - board.units.filter(u => u.power === power).length;
const distinct = (indices: readonly number[], limit: number): number[] => {
  if (!Array.isArray(indices) || indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= limit) || new Set(indices).size !== indices.length)
    throw new ChoiceError('Choices must be distinct numbers from the list.');
  return [...indices];
};
// HOLD and MOVE are kept before SUPPORT and CONVOY when a catalog has to shrink.
const rank = (order: Order) => order.type === 'HOLD' ? 0 : order.type === 'MOVE' ? 1 : order.type === 'CONVOY' ? 3 : 2;

const province = (place: string) => place.split('/')[0];
/**
 * Whether an order can serve this power at all. There is no negotiation in this game, so helping
 * another power's unit is never part of a plan; and a support is pointless where nobody else can
 * reach. `contested` holds every territory a foreign unit occupies or could move to this turn.
 * Holds and moves are always kept, so a pruned catalog still admits a fully legal answer.
 */
function purposeful(id: string, own: ReadonlySet<string>, contested: ReadonlySet<string>): boolean {
  const [, type, first, second] = id.split('|');
  if (type === 'SUPPORT_HOLD') return own.has(province(first)) && contested.has(province(first));
  if (type === 'SUPPORT_MOVE') return own.has(province(first)) && contested.has(province(second ?? ''));
  if (type === 'CONVOY') return own.has(province(first));
  return true;
}
/** What a move would reach: whose supply center it is, and whether another power's unit is there now. Public board facts only. */
function destinationNote(board: BoardFixture, power: Power, id: string): string {
  const [, type, target] = id.split('|');
  if (type !== 'MOVE' && type !== 'MOVE_VIA_CONVOY') return '';
  const place = province(target), notes: string[] = [];
  if (TERRITORY_MAP[place]?.isSupplyCenter) {
    const owner = (board.territoryOwners as Record<string, Power | null | undefined>)[place] ?? null;
    notes.push(owner === power ? 'your supply center' : owner ? `${owner} supply center` : 'unowned supply center');
  }
  const occupant = board.units.find(u => u.territory === place && !u.mustRetreat);
  if (occupant) notes.push(occupant.power === power ? 'your own unit is there' : `${occupant.power} unit there`);
  return notes.length ? ` (${notes.join(', ')})` : '';
}
export type CoherenceIssue = 'SELF_BLOCKED_MOVE' | 'SAME_DESTINATION' | 'UNMATCHED_SUPPORT' | 'FOREIGN_SUPPORT' | 'UNMATCHED_CONVOY';
/**
 * Ways one power's own orders work against each other, judged from the orders alone. These are all
 * legal, which is why the rules engine accepts them; they are reported so that play quality can be
 * measured and compared, not to reject an answer.
 */
export function coherenceIssues(orderIds: readonly string[]): CoherenceIssue[] {
  const orders = orderIds.map(id => { const [unit, type, first, second] = id.split('|'); return { unit, type, first, second }; });
  const byUnit = new Map(orders.map(o => [province(o.unit),o])), at = (place: string) => byUnit.get(province(place));
  const moving = (o: typeof orders[number]) => o.type === 'MOVE' || o.type === 'MOVE_VIA_CONVOY', issues = new Set<CoherenceIssue>();
  const destinations = orders.filter(moving).map(o => province(o.first));
  if (new Set(destinations).size !== destinations.length) issues.add('SAME_DESTINATION');
  for (const o of orders) {
    if (moving(o)) {
      const occupant = at(o.first);
      // Moving into your own unit works only if that unit leaves, and not by simply swapping places.
      if (occupant && (!moving(occupant) || province(occupant.first) === province(o.unit) && occupant.type === 'MOVE' && o.type === 'MOVE')) issues.add('SELF_BLOCKED_MOVE');
      if (o.type === 'MOVE_VIA_CONVOY' && !orders.some(f => f.type === 'CONVOY' && province(f.first) === province(o.unit) && province(f.second ?? '') === province(o.first))) issues.add('UNMATCHED_CONVOY');
    } else if (o.type === 'SUPPORT_HOLD' || o.type === 'SUPPORT_MOVE') {
      const supported = at(o.first);
      if (!supported) issues.add('FOREIGN_SUPPORT');
      else if (o.type === 'SUPPORT_HOLD' ? moving(supported) : !moving(supported) || province(supported.first) !== province(o.second ?? '')) issues.add('UNMATCHED_SUPPORT');
    } else if (o.type === 'CONVOY') {
      const army = at(o.first);
      // The rules engine also accepts a plain move to a place only a convoy can reach, so either form matches.
      if (army && !(moving(army) && province(army.first) === province(o.second ?? ''))) issues.add('UNMATCHED_CONVOY');
    }
  }
  return [...issues].sort();
}

/**
 * Movement: exactly one choice per active unit. `legal` is Godip's catalog for this power.
 * `keepPerUnit` trims each unit's list in a fixed order; a unit's HOLD is always first, so a
 * trimmed catalog still admits a fully legal answer.
 */
export function orderChoices(board: BoardFixture, power: Power, legal: readonly LegalOption[], keepPerUnit = Number.MAX_SAFE_INTEGER, contested?: ReadonlySet<string>): ChoiceSet | null {
  const units = board.units.filter(u => u.power === power && !u.mustRetreat).sort((a,b) => a.territory.localeCompare(b.territory));
  if (!units.length) return null;
  if (contested) legal = legal.filter(option => purposeful(option.id,new Set(units.map(u => u.territory)),contested));
  // Godip lists a move to a place only a convoy can reach twice: as a plain move and as "via convoy".
  // They are the same order, so only the explicit one is offered.
  const explicit = new Set(legal.filter(o => o.id.split('|')[1] === 'MOVE_VIA_CONVOY').map(o => `${o.unitTerritory}>${province(o.id.split('|')[2])}`));
  legal = legal.filter(o => { const [unit, type, target] = o.id.split('|');
    return !(type === 'MOVE' && explicit.has(`${o.unitTerritory}>${province(target)}`) && !(ADJACENCY[province(unit) as keyof typeof ADJACENCY]?.army ?? []).includes(province(target) as never)); });
  const choices: Choice[] = [], ids: string[] = [], groups: ChoiceSet['groups'] = [];
  for (const unit of units) {
    const own = legal.filter(o => o.unitTerritory === unit.territory && o.order.power === power)
      .sort((a,b) => rank(a.order) - rank(b.order) || a.id.localeCompare(b.id));
    if (!own.some(o => o.order.type === 'HOLD')) throw new ChoiceError(`No legal HOLD for ${unit.territory}.`);
    // Trimming keeps the hold; the list then shows it last, so standing still is not the first thing offered.
    const listed = own.slice(0,Math.max(1,keepPerUnit)).sort((a,b) => Number(a.order.type === 'HOLD') - Number(b.order.type === 'HOLD')), group = { id: unit.territory, label: unitLabel(unit.type,unit.territory,unit.coast), choices: [] as number[] };
    for (const option of listed) { group.choices.push(choices.length); choices.push({ group: unit.territory, label: `${option.description || option.id}${destinationNote(board,power,option.id)}` }); ids.push(option.id); }
    groups.push(group);
  }
  return { power, phase: 'ORDERS', rule: `Pick exactly one number for each of your ${units.length} unit${units.length === 1 ? '' : 's'}.`, groups, choices,
    coverage: { listed: choices.length, total: legal.filter(o => o.order.power === power && units.some(u => u.territory === o.unitTerritory)).length },
    toAction(indices) {
      const picked = distinct(indices,choices.length);
      if (picked.length !== units.length || new Set(picked.map(i => choices[i].group)).size !== units.length) throw new ChoiceError('Pick exactly one order for each unit.');
      return { phase: 'ORDERS', orderIds: picked.map(i => ids[i]) };
    } };
}

/** Retreats: one choice per dislodged unit, each either a listed destination or disband. */
export function retreatChoices(board: BoardFixture, power: Power): ChoiceSet | null {
  const units = board.units.filter(u => u.power === power && u.mustRetreat).sort((a,b) => a.id.localeCompare(b.id));
  if (!units.length) return null;
  const choices: Choice[] = [], targets: Array<{ unitId: string; destination: { territory: string; coast: string | null } | null }> = [], groups: ChoiceSet['groups'] = [];
  for (const unit of units) {
    const group = { id: unit.id, label: `${unitLabel(unit.type,unit.territory,unit.coast)} (dislodged)`, choices: [] as number[] };
    const add = (label: string, destination: typeof targets[number]['destination']) => { group.choices.push(choices.length); choices.push({ group: unit.id, label }); targets.push({ unitId: unit.id, destination }); };
    add('disband',null);
    for (const territory of [...unit.retreatOptions].sort()) {
      const coasts = unit.retreatCoasts[territory];
      if (coasts?.length) for (const coast of [...coasts].sort()) add(`retreat to ${territory}/${coast}`,{ territory, coast });
      else add(`retreat to ${territory}`,{ territory, coast: null });
    }
    groups.push(group);
  }
  return { power, phase: 'RETREATS', rule: `Pick exactly one number for each of your ${units.length} dislodged unit${units.length === 1 ? '' : 's'}.`, groups, choices,
    coverage: { listed: choices.length, total: choices.length },
    toAction(indices) {
      const picked = distinct(indices,choices.length);
      if (picked.length !== units.length || new Set(picked.map(i => choices[i].group)).size !== units.length) throw new ChoiceError('Pick exactly one retreat for each dislodged unit.');
      return { phase: 'RETREATS', retreats: Object.fromEntries(picked.map(i => [targets[i].unitId,targets[i].destination])) } as PhaseAction;
    } };
}

/** Adjustments: up to `delta` builds in distinct home centers, or exactly `-delta` disbands. */
export function buildChoices(board: BoardFixture, power: Power): AdjustmentChoiceSet | null {
  const delta = adjustment(board,power);
  if (delta === 0) return null;
  const choices: Choice[] = [];
  if (delta < 0) {
    const units = board.units.filter(u => u.power === power).sort((a,b) => a.id.localeCompare(b.id)), need = -delta;
    for (const unit of units) choices.push({ group: unit.id, label: `disband ${unitLabel(unit.type,unit.territory,unit.coast)}` });
    return { power, phase: 'BUILDS', rule: `Pick exactly ${need} number${need === 1 ? '' : 's'}: the unit${need === 1 ? '' : 's'} to disband.`,
      groups: [{ id: 'disband', label: 'Disband', choices: choices.map((_,i) => i) }], choices, defaultIndices: units.slice(0,need).map((_,i)=>i), coverage: { listed: choices.length, total: choices.length },
      toAction(indices) {
        const picked = distinct(indices,choices.length);
        if (picked.length !== need) throw new ChoiceError(`Exactly ${need} units must be disbanded.`);
        return { phase: 'BUILDS', builds: [], disbands: picked.map(i => units[i].id) };
      } };
  }
  const builds: Array<{ type: 'ARMY' | 'FLEET'; territory: string; coast: string | null }> = [], groups: ChoiceSet['groups'] = [];
  const homes = TERRITORIES.filter(t => t.homePower === power && t.isSupplyCenter && board.territoryOwners[t.id] === power && !board.units.some(u => u.territory === t.id))
    .sort((a,b) => a.id.localeCompare(b.id));
  for (const home of homes) {
    const group = { id: home.id, label: `Build in ${home.id}`, choices: [] as number[] };
    const add = (type: 'ARMY' | 'FLEET', coast: string | null) => { group.choices.push(choices.length); choices.push({ group: home.id, label: `build ${unitLabel(type,home.id,coast)}` }); builds.push({ type, territory: home.id, coast }); };
    add('ARMY',null);
    if (TERRITORY_MAP[home.id].type !== 'LAND') { if (home.coasts.length) for (const coast of [...home.coasts].sort()) add('FLEET',coast); else add('FLEET',null); }
    groups.push(group);
  }
  const allowed = Math.min(delta,homes.length);
  // Nothing can be built: the only legal adjustment is to waive, so there is nothing to ask.
  if (!allowed) return null;
  return { power, phase: 'BUILDS', rule: `Pick up to ${allowed} number${allowed === 1 ? '' : 's'}, at most one per home center. An empty list waives your builds.`, groups, choices, defaultIndices: groups.slice(0,allowed).map(g=>g.choices[0]),
    coverage: { listed: choices.length, total: choices.length },
    toAction(indices) {
      const picked = distinct(indices,choices.length);
      if (picked.length > allowed || new Set(picked.map(i => choices[i].group)).size !== picked.length) throw new ChoiceError('Too many builds, or two builds in one center.');
      return { phase: 'BUILDS', builds: picked.map(i => builds[i]), disbands: [] } as PhaseAction;
    } };
}

/** What a power does when it has nothing to choose. No provider call is made for it. */
export function forcedAction(board: BoardFixture): PhaseAction {
  return board.phase === 'ORDERS' ? { phase: 'ORDERS', orderIds: [] } : board.phase === 'RETREATS' ? { phase: 'RETREATS', retreats: {} } : { phase: 'BUILDS', builds: [], disbands: [] };
}
/** Strict reading of the model's JSON: exactly `{choices: integer[]}` within the preset's schema bounds. */
export function parseChoices(value: unknown): number[] {
  const v = value as { choices?: unknown };
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1 || !Array.isArray(v.choices) || v.choices.length > 34
    || v.choices.some(i => !Number.isSafeInteger(i) || (i as number) < 0 || (i as number) > 100_000)) throw new ChoiceError('Expected {"choices":[integers]}.');
  return v.choices as number[];
}
