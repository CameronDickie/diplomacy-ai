import { createHash } from 'node:crypto';
import { ADJACENCY, TERRITORIES, TERRITORY_MAP } from '@diplomacy/shared';
import type { Power } from '@diplomacy/shared';
import type { BoardFixture } from '../fixtures/BoardFixture.js';
import { buildChoices, forcedAction, retreatChoices, type LegalOption } from '../luna/Choices.js';
import type { DecisionContext, DecisionProvider } from './AttemptService.js';
import type { PhaseRules } from './PhaseRules.js';
import type { PhaseAction, PhaseDecisions } from './types.js';

/** Neighbours for route-finding only; every order the bot issues still comes from the engine's legal catalog. */
const NEIGHBOURS: Record<string,string[]> = Object.fromEntries(Object.entries(ADJACENCY).map(([id,entry]) =>
  [id,[...new Set([...entry.army,...(Array.isArray(entry.fleet) ? entry.fleet : Object.values(entry.fleet).flat())])] as string[]]));
/** Steps from each territory to the nearest of `targets`, over the whole map. */
function distances(targets: Iterable<string>): Map<string,number> {
  const seen = new Map<string,number>(), queue: string[] = [];
  for (const target of targets) { seen.set(target,0); queue.push(target); }
  for (let i = 0; i < queue.length; i++) for (const next of NEIGHBOURS[queue[i]] ?? []) if (!seen.has(next)) { seen.set(next,seen.get(queue[i])! + 1); queue.push(next); }
  return seen;
}
/** Small deterministic generator: the same attempt, phase and power always produce the same sequence. */
function seeded(...parts: string[]): () => number {
  let state = createHash('sha256').update(parts.join('|')).digest().readUInt32LE(0) || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32; };
}

function orders(board: BoardFixture, power: Power, legal: readonly LegalOption[], random: () => number): PhaseAction {
  const units = board.units.filter(u => u.power === power && !u.mustRetreat).sort((a,b) => a.territory.localeCompare(b.territory));
  const mine = new Set(units.map(u => u.territory)), occupied = new Map(board.units.map(u => [u.territory,u.power]));
  const wanted = TERRITORIES.filter(t => t.isSupplyCenter && board.territoryOwners[t.id] !== power).map(t => t.id), toGoal = distances(wanted);
  const enemyNear = (territory: string) => (NEIGHBOURS[territory] ?? []).some(n => occupied.has(n) && occupied.get(n) !== power);
  const optionsFor = (territory: string) => legal.filter(o => o.unitTerritory === territory && o.order.power === power);
  const hold = (territory: string) => optionsFor(territory).find(o => o.order.type === 'HOLD')!;
  // A unit standing on one of its own home centers with an enemy next to it stays to defend it.
  const defends = (territory: string) => TERRITORY_MAP[territory]?.homePower === power && board.territoryOwners[territory] === power && enemyNear(territory);
  const value = (target: string): number => {
    const t = TERRITORY_MAP[target], owner = board.territoryOwners[target] ?? null;
    let score = -(toGoal.get(target) ?? 9);
    // Centers change hands only after Fall, so arriving in Fall is worth more than passing through in Spring.
    if (t?.isSupplyCenter && owner !== power) score += (owner === null ? 6 : 5) + (board.season === 'FALL' ? 4 : 1);
    if (occupied.has(target) && occupied.get(target) !== power) score -= 3;
    return score + random() * 0.5;
  };
  const chosen = new Map<string,LegalOption>(), claimed = new Set<string>();
  const movers = units.filter(u => !defends(u.territory)).map(u => {
    const here = -(toGoal.get(u.territory) ?? 9) + (TERRITORY_MAP[u.territory]?.isSupplyCenter && board.territoryOwners[u.territory] !== power && board.season === 'FALL' ? 12 : 0);
    const moves = optionsFor(u.territory).filter(o => o.order.type === 'MOVE' && o.order.targetTerritory && !mine.has(o.order.targetTerritory))
      .map(option => ({ option, score: value(option.order.targetTerritory!) })).filter(m => m.score > here).sort((a,b) => b.score - a.score || a.option.id.localeCompare(b.option.id));
    return { unit: u, moves };
  }).sort((a,b) => (b.moves[0]?.score ?? -99) - (a.moves[0]?.score ?? -99) || a.unit.territory.localeCompare(b.unit.territory));
  // Best prospects choose first; no two units are sent to the same place.
  for (const { unit, moves } of movers) {
    const pick = moves.find(m => !claimed.has(m.option.order.targetTerritory!));
    if (pick) { chosen.set(unit.territory,pick.option); claimed.add(pick.option.order.targetTerritory!); }
  }
  for (const unit of units) {
    if (chosen.has(unit.territory)) continue;
    const available = optionsFor(unit.territory);
    // A unit with nothing better to do backs a friend's attack on an occupied or contested center, then a friend's defence.
    const backing = available.filter(o => o.order.type === 'SUPPORT_MOVE').map(o => ({ option: o, move: chosen.get(o.order.supportedUnit ?? '') }))
      .filter(s => s.move?.order.type === 'MOVE' && s.move.order.targetTerritory === s.option.order.supportedDestination)
      .sort((a,b) => Number(occupied.has(b.option.order.supportedDestination!)) - Number(occupied.has(a.option.order.supportedDestination!)) || a.option.id.localeCompare(b.option.id))[0];
    const guarding = available.filter(o => o.order.type === 'SUPPORT_HOLD' && mine.has(o.order.supportedUnit ?? '') && !chosen.has(o.order.supportedUnit!) && defends(o.order.supportedUnit!))
      .sort((a,b) => a.id.localeCompare(b.id))[0];
    chosen.set(unit.territory,backing?.option ?? guarding ?? hold(unit.territory));
  }
  return { phase: 'ORDERS', orderIds: units.map(u => chosen.get(u.territory)!.id) };
}

function retreats(board: BoardFixture, power: Power): PhaseAction {
  const set = retreatChoices(board,power);
  if (!set) return forcedAction(board);
  // Prefer a center that is not ours yet, then one of our own, then anywhere; disband only when there is nowhere to go.
  const worth = (label: string): number => {
    const territory = /retreat to ([A-Z]+)/.exec(label)?.[1];
    if (!territory) return -1;
    const t = TERRITORY_MAP[territory];
    return t?.isSupplyCenter ? (board.territoryOwners[territory] === power ? 2 : 3) : 1;
  };
  return set.toAction(set.groups.map(group => [...group.choices].sort((a,b) => worth(set.choices[b].label) - worth(set.choices[a].label) || a - b)[0]));
}

function adjustments(board: BoardFixture, power: Power, random: () => number): PhaseAction {
  const set = buildChoices(board,power);
  if (!set) return forcedAction(board);
  const need = /exactly (\d+)/.exec(set.rule);
  if (need) {
    // Give up the units furthest from home first.
    const fromHome = distances(TERRITORIES.filter(t => t.homePower === power).map(t => t.id)), units = board.units.filter(u => u.power === power).sort((a,b) => a.id.localeCompare(b.id));
    return set.toAction(units.map((u,i) => ({ i, far: fromHome.get(u.territory) ?? 9 })).sort((a,b) => b.far - a.far || a.i - b.i).slice(0,Number(need[1])).map(x => x.i));
  }
  const allowed = Number(/up to (\d+)/.exec(set.rule)![1]), fleets = board.units.filter(u => u.power === power && u.type === 'FLEET').length, armies = board.units.filter(u => u.power === power).length - fleets;
  // Keep a rough two-to-one balance of armies to fleets where the coast allows a fleet.
  return set.toAction(set.groups.slice(0,allowed).map(group => {
    const fleet = group.choices.filter(i => /build F /.test(set.choices[i].label));
    return fleet.length && fleets * 2 < armies + 1 ? fleet[Math.floor(random() * fleet.length)] : group.choices[0];
  }));
}

/**
 * A free practice opponent: seeded, deterministic and legal by construction. It seeks supply
 * centers, avoids sending two units to one place, adds supports that match a friend's order,
 * defends threatened home centers and makes plain retreat and adjustment choices. It makes no
 * provider call and is never used for a sponsored attempt.
 */
export function practiceBot(rules: PhaseRules): DecisionProvider {
  const decide = async ({ job, signal }: DecisionContext): Promise<PhaseDecisions> => {
    const decisions: PhaseDecisions = {};
    for (const power of job.definition.opponentPowers) {
      signal.throwIfAborted();
      // Seeded from the attempt and the phase's starting position, so a recovery repeats the same choice.
      const random = seeded(job.attemptId,job.phaseId,power);
      decisions[power] = job.board.phase === 'ORDERS' ? orders(job.board,power,await rules.legal(job.board,power,signal),random)
        : job.board.phase === 'RETREATS' ? retreats(job.board,power) : adjustments(job.board,power,random);
    }
    return decisions;
  };
  return { decide, recover: decide };
}
