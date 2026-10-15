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
  /** Plain-text hints shown after the choices (a full game's convoys that could be set up for next turn). */
  notes?: string[];
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
function purposeful(id: string, own: ReadonlySet<string>, contested: ReadonlySet<string>, partners: ReadonlySet<string>): boolean {
  const [, type, first, second] = id.split('|');
  // Helping the human's unit is possible only after talking with them: an agreement has to be executable.
  if ((type === 'SUPPORT_HOLD' || type === 'SUPPORT_MOVE' || type === 'CONVOY') && partners.has(province(first))) return true;
  if (type === 'SUPPORT_HOLD') return own.has(province(first)) && contested.has(province(first));
  if (type === 'SUPPORT_MOVE') return own.has(province(first)) && contested.has(province(second ?? ''));
  if (type === 'CONVOY') return own.has(province(first));
  return true;
}
/**
 * What an order touches, from public board facts only. For a move: whose supply center the
 * destination is, whether a unit is there now, and which other unit of yours could also be sent
 * there (two units sent to one place both fail, which models did repeatedly). For a support or
 * convoy of another power's unit: whose unit it is, so it is not mistaken for one of your own.
 */
function destinationNote(board: BoardFixture, power: Power, id: string, rivals: ReadonlyMap<string, readonly string[]> | null = null): string {
  const [unit, type, target] = id.split('|');
  if (type === 'SUPPORT_HOLD' || type === 'SUPPORT_MOVE' || type === 'CONVOY') {
    if (!rivals) return '';
    const helped = board.units.find(u => u.territory === province(target) && !u.mustRetreat);
    return helped && helped.power !== power ? ` (${helped.power}'s unit)` : '';
  }
  if (type !== 'MOVE' && type !== 'MOVE_VIA_CONVOY') return '';
  const place = province(target), notes: string[] = [];
  if (TERRITORY_MAP[place]?.isSupplyCenter) {
    const owner = (board.territoryOwners as Record<string, Power | null | undefined>)[place] ?? null;
    notes.push(owner === power ? 'your supply center' : owner ? `${owner} supply center` : 'unowned supply center');
  }
  const occupant = board.units.find(u => u.territory === place && !u.mustRetreat);
  if (occupant) notes.push(occupant.power === power ? 'your own unit is there' : `${occupant.power} unit there`);
  const others = (rivals?.get(place) ?? []).filter(label => label.split(' ')[1] !== province(unit));
  // Kept short: a large power has many overlapping moves and the list must still fit its request.
  if (others.length && type === 'MOVE') notes.push(`shared with ${others.slice(0,3).join(', ')}`);
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
 * Moves of one power that cannot all succeed because they get in each other's way, in words a
 * model can act on: two or more of its units sent to the same place (only one can arrive), or a
 * unit sent into a place another of its units is not leaving. Empty when there are none.
 */
/**
 * Convoys of one power that cannot work because their other half is missing: an army sent by
 * convoy that none of its fleets convoys (fine only if another power agreed to), or a fleet
 * convoying one of its armies that is not making that move. Empty when there are none.
 */
export function convoyMismatches(orderIds: readonly string[]): string[] {
  const orders = orderIds.map(id => { const [unit, type, first, second] = id.split('|'); return { unit, type, first, second }; });
  const found: string[] = [];
  for (const o of orders) {
    if (o.type === 'MOVE_VIA_CONVOY' && !orders.some(f => f.type === 'CONVOY' && province(f.first) === province(o.unit) && province(f.second ?? '') === province(o.first)))
      found.push(`your army in ${o.unit} was sent to ${o.first} by convoy, but none of your fleets was ordered to convoy it (keep that only if another power agreed to convoy it)`);
    if (o.type === 'CONVOY') {
      const army = orders.find(a => province(a.unit) === province(o.first));
      if (army && !((army.type === 'MOVE_VIA_CONVOY' || army.type === 'MOVE') && province(army.first) === province(o.second ?? '')))
        found.push(`your fleet in ${o.unit} was ordered to convoy ${o.first} to ${o.second}, but your army in ${o.first} was not ordered to move there by convoy`);
    }
  }
  return found;
}
export function selfBlockingMoves(orderIds: readonly string[]): string[] {
  const orders = orderIds.map(id => { const [unit, type, first] = id.split('|'); return { unit, type, first }; });
  const moving = (o: typeof orders[number]) => o.type === 'MOVE' || o.type === 'MOVE_VIA_CONVOY';
  const list = (names: string[]) => names.length < 3 ? names.join(' and ') : `${names.slice(0,-1).join(', ')} and ${names.at(-1)}`;
  const found: string[] = [], into = new Map<string, string[]>();
  for (const o of orders.filter(moving)) into.set(province(o.first),[...(into.get(province(o.first)) ?? []),o.unit]);
  for (const [place, units] of into) if (units.length > 1) found.push(`your units in ${list(units)} were all sent to ${place}, where only one can arrive`);
  for (const o of orders.filter(moving)) {
    const occupant = orders.find(f => province(f.unit) === province(o.first));
    if (occupant && !moving(occupant)) found.push(`your unit in ${o.unit} was sent to ${occupant.unit}, where your own unit is staying`);
  }
  return found;
}

/**
 * The supply centers that change hands after this Fall if the units now on them stay: a unit standing
 * on a center its power does not own. Models moved such units away in about half of these cases,
 * giving up a center they had walked into in Spring. Empty outside a Fall orders phase.
 */
export function pendingCaptures(board: BoardFixture): Array<{ center: string; power: Power; from: Power | null; unit: string }> {
  if (board.season !== 'FALL' || board.phase !== 'ORDERS') return [];
  return board.units.filter(u => !u.mustRetreat && TERRITORY_MAP[u.territory]?.isSupplyCenter && board.territoryOwners[u.territory] !== u.power)
    .map(u => ({ center: u.territory, power: u.power, from: board.territoryOwners[u.territory] ?? null, unit: unitLabel(u.type,u.territory,u.coast) }))
    .sort((a,b) => a.center.localeCompare(b.center));
}
/** On each order of a unit about to take a center this Fall: whether it keeps the center or gives it up. */
function captureNote(board: BoardFixture, power: Power, id: string): string {
  const [unit, type] = id.split('|'), place = province(unit);
  if (!pendingCaptures(board).some(c => c.power === power && c.center === place)) return '';
  return type === 'MOVE' || type === 'MOVE_VIA_CONVOY' ? ` (leaving gives up ${place}, which becomes yours after this Fall if this unit stays)` : ` (staying takes ${place} after this Fall)`;
}
type OwnUnit = BoardFixture['units'][number];
const label = (unit: OwnUnit) => unitLabel(unit.type,unit.territory,unit.coast);
const fleetNeighbours = (place: string) => { const fleet = ADJACENCY[place as keyof typeof ADJACENCY]?.fleet; return [...new Set((Array.isArray(fleet) ? fleet : Object.values(fleet ?? {}).flat()).map(t => province(t)))]; };
/**
 * A convoy takes two orders under two headings, the army's and the fleet's, and neither works alone.
 * Each says which order of yours it depends on (a full game only).
 */
function convoyNote(power: Power, units: readonly OwnUnit[], legal: readonly LegalOption[], id: string): string {
  const [unit, type, first, second] = id.split('|');
  if (type === 'MOVE_VIA_CONVOY') {
    const fleets = legal.filter(o => o.order.power === power && o.id.split('|')[1] === 'CONVOY' && province(o.id.split('|')[2]) === province(unit) && province(o.id.split('|')[3] ?? '') === province(first))
      .map(o => units.find(u => u.territory === o.unitTerritory)).filter((u): u is OwnUnit => Boolean(u)).map(label);
    return fleets.length ? ` (arrives only if ${fleets.slice(0,3).join(' or ')} also convoys it there this turn)` : ' (arrives only if another power\'s fleet convoys it there this turn)';
  }
  if (type === 'CONVOY') {
    const army = units.find(u => u.territory === province(first));
    return army ? ` (works only if ${label(army)} also moves to ${province(second ?? '')} by convoy this turn)` : '';
  }
  return '';
}
/**
 * For each of this power's armies on a coast: which fleet move this turn would let it be convoyed
 * next turn, and to where it could not otherwise go. Models rarely set convoys up a turn ahead.
 */
function convoyPlans(power: Power, units: readonly OwnUnit[], legal: readonly LegalOption[]): string[] {
  const lines: string[] = [];
  for (const army of units.filter(u => u.type === 'ARMY' && TERRITORY_MAP[u.territory]?.type === 'COASTAL')) {
    const walk = new Set((ADJACENCY[army.territory as keyof typeof ADJACENCY]?.army ?? []).map(t => province(t)));
    let shown = 0;
    for (const sea of fleetNeighbours(army.territory).filter(t => TERRITORY_MAP[t]?.type === 'SEA').sort()) {
      if (shown >= 2 || lines.length >= 6) break;
      // A fleet already there can convoy this turn; those orders are in the list above.
      if (units.some(u => u.type === 'FLEET' && province(u.territory) === sea)) continue;
      const movers = units.filter(u => u.type === 'FLEET' && legal.some(o => o.unitTerritory === u.territory && o.order.power === power && o.id.split('|')[1] === 'MOVE' && province(o.id.split('|')[2]) === sea));
      if (!movers.length) continue;
      const reach = fleetNeighbours(sea).filter(t => TERRITORY_MAP[t]?.type !== 'SEA' && t !== army.territory && !walk.has(t)).sort();
      if (!reach.length) continue;
      lines.push(`- ${label(army)}: move ${movers.slice(0,2).map(label).join(' or ')} to ${sea} this turn, and next turn ${label(army)} can be convoyed from there to ${reach.slice(0,6).join(', ')}.`);
      shown++;
    }
  }
  return lines;
}

/**
 * Movement: exactly one choice per active unit. `legal` is Godip's catalog for this power.
 * `keepPerUnit` trims each unit's list in a fixed order; a unit's HOLD is always first, so a
 * trimmed catalog still admits a fully legal answer.
 */
export function orderChoices(board: BoardFixture, power: Power, legal: readonly LegalOption[], keepPerUnit = Number.MAX_SAFE_INTEGER, contested?: ReadonlySet<string>, partners: ReadonlySet<string> = new Set(), shareNotes = true, fullGame: { convoys?: boolean; captures?: boolean } = {}): ChoiceSet | null {
  const units = board.units.filter(u => u.power === power && !u.mustRetreat).sort((a,b) => a.territory.localeCompare(b.territory));
  if (!units.length) return null;
  if (contested) legal = legal.filter(option => purposeful(option.id,new Set(units.map(u => u.territory)),contested,partners));
  // Godip lists a move to a place only a convoy can reach twice: as a plain move and as "via convoy".
  // They are the same order, so only the explicit one is offered.
  const explicit = new Set(legal.filter(o => o.id.split('|')[1] === 'MOVE_VIA_CONVOY').map(o => `${o.unitTerritory}>${province(o.id.split('|')[2])}`));
  legal = legal.filter(o => { const [unit, type, target] = o.id.split('|');
    return !(type === 'MOVE' && explicit.has(`${o.unitTerritory}>${province(target)}`) && !(ADJACENCY[province(unit) as keyof typeof ADJACENCY]?.army ?? []).includes(province(target) as never)); });
  const choices: Choice[] = [], ids: string[] = [], groups: ChoiceSet['groups'] = [];
  // Which of this power's units could each be ordered to a given territory.
  const rivals = new Map<string, string[]>();
  for (const option of legal) {
    const [, type, target] = option.id.split('|'), mover = units.find(u => u.territory === option.unitTerritory);
    if (!shareNotes || type !== 'MOVE' || !mover || option.order.power !== power) continue;
    const label = `${mover.type === 'ARMY' ? 'A' : 'F'} ${mover.territory}`, list = rivals.get(province(target)) ?? [];
    if (!list.includes(label)) rivals.set(province(target),[...list,label]);
  }
  for (const unit of units) {
    const own = legal.filter(o => o.unitTerritory === unit.territory && o.order.power === power)
      .sort((a,b) => rank(a.order) - rank(b.order) || a.id.localeCompare(b.id));
    if (!own.some(o => o.order.type === 'HOLD')) throw new ChoiceError(`No legal HOLD for ${unit.territory}.`);
    // Trimming keeps the hold; the list then shows it last, so standing still is not the first thing offered.
    const listed = own.slice(0,Math.max(1,keepPerUnit)).sort((a,b) => Number(a.order.type === 'HOLD') - Number(b.order.type === 'HOLD')), group = { id: unit.territory, label: unitLabel(unit.type,unit.territory,unit.coast), choices: [] as number[] };
    for (const option of listed) { group.choices.push(choices.length); choices.push({ group: unit.territory, label: `${option.description || option.id}${destinationNote(board,power,option.id,shareNotes ? rivals : null)}${fullGame.convoys ? convoyNote(power,units,legal,option.id) : ''}${fullGame.captures ? captureNote(board,power,option.id) : ''}` }); ids.push(option.id); }
    groups.push(group);
  }
  const shared = choices.some(c => c.label.includes('shared with ')) ? ' "Shared with" names other units of yours that can move to the same place: send only one of them there, or both fail.' : '';
  const plans = fullGame.convoys ? convoyPlans(power,units,legal) : [];
  const taking = fullGame.captures ? pendingCaptures(board).filter(c => c.power === power) : [];
  return { power, phase: 'ORDERS', rule: `Pick exactly one number for each of your ${units.length} unit${units.length === 1 ? '' : 's'}.${shared}`, groups, choices,
    ...(plans.length || taking.length ? { notes: [
      ...(taking.length ? [`Supply centers that become yours after this Fall only if the unit on each is still there when the turn ends: ${taking.map(c => `${c.center} (${c.unit})`).join(', ')}. Moving that unit away gives the center up unless another of your units moves in.`] : []),
      ...(plans.length ? ['Convoys you could set up for next turn. Only a fleet at sea next to an army can convoy it; a fleet in a coastal province cannot.',...plans] : [])] } : {}),
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
  // With more free centers than builds, a model reads the headings as one pick each; the count is spelled out.
  const fewer = allowed < homes.length ? ` You have ${homes.length} free home centers but only ${allowed} build${allowed === 1 ? '' : 's'}, so choose which center${allowed === 1 ? '' : 's'} to build in: do not pick one number under every heading.` : '';
  return { power, phase: 'BUILDS', rule: `Pick up to ${allowed} number${allowed === 1 ? '' : 's'} in total, at most one per home center.${fewer} An empty list waives your builds.`, groups, choices, defaultIndices: groups.slice(0,allowed).map(g=>g.choices[0]),
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

/** The territory a model meant by a unit name: "A BUL", "F BUL/SOUTH" and "bul" are all BUL. */
const unitKey = (name: string) => name.trim().toUpperCase().replace(/^(?:A|F|ARMY|FLEET)\s+/,'').split('/')[0].trim();
/**
 * Strict reading of a full game's orders answer, `{orders:[{unit,choice}]}`, into the same list of
 * numbers `toAction` takes. Each entry must name one of the power's units and a number from under
 * that unit's own heading, and every unit must appear exactly once. Anything else is refused with a
 * message that says which unit and why, in terms of the list; that message is safe to show the model.
 */
export function parseUnitOrders(value: unknown, set: ChoiceSet): number[] {
  const v = value as { orders?: unknown };
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1 || !Array.isArray(v.orders) || v.orders.length > 34) throw new ChoiceError('the answer was not {"orders":[{"unit","choice"}]}');
  const byUnit = new Map(set.groups.map(g => [unitKey(g.id),g])), picked = new Map<string, number>(), problems: string[] = [];
  for (const entry of v.orders as Array<{ unit?: unknown; choice?: unknown }>) {
    if (!entry || typeof entry !== 'object' || typeof entry.unit !== 'string' || !Number.isSafeInteger(entry.choice)) throw new ChoiceError('the answer was not {"orders":[{"unit","choice"}]}');
    const key = unitKey(entry.unit), group = byUnit.get(key), choice = entry.choice as number;
    if (!group) problems.push(`${key.slice(0,12) || 'an unnamed unit'} is not one of your units`);
    else if (picked.has(group.id)) problems.push(`${group.label} was given more than once`);
    else if (!group.choices.includes(choice)) problems.push(`${choice} is not one of the numbers under ${group.label} (those are ${group.choices[0]} to ${group.choices.at(-1)})`);
    else picked.set(group.id,choice);
  }
  const missed = set.groups.filter(g => !picked.has(g.id)).map(g => g.label);
  if (missed.length) problems.push(`no usable order for ${missed.join(', ')}`);
  if (problems.length) throw new ChoiceError(problems.slice(0,6).join('; '));
  return set.groups.map(g => picked.get(g.id)!);
}
