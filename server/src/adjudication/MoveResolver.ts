import type { GameState, Order, ResolvedOrder, OrderResolution } from '@diplomacy/shared';
import { getArmyAdjacency, getFleetAdjacency } from '@diplomacy/shared';
import { findConvoyPaths } from './ConvoyResolver.js';

type Resolution = 'SUCCEEDS' | 'FAILS' | 'BOUNCED' | 'CUT' | 'VOID' | 'UNRESOLVED';

interface WorkingOrder extends Order {
  resolution: Resolution;
  reason: string;
  /** Effective support strength (after cuts applied) */
  supportCount: number;
}

/**
 * Core adjudication: resolves all orders using the iterative label algorithm.
 * Handles moves, holds, supports, and convoys.
 */
export function resolveMoves(orders: Order[], state: GameState): ResolvedOrder[] {
  // Build working orders with initial state
  const working: WorkingOrder[] = orders.map(o => ({
    ...o,
    resolution: 'UNRESOLVED' as Resolution,
    reason: '',
    supportCount: 0,
  }));

  // --- Phase 1: Determine support counts (before cutting) ---
  for (const wo of working) {
    if (wo.type === 'SUPPORT_HOLD' || wo.type === 'SUPPORT_MOVE') {
      const target = wo.type === 'SUPPORT_HOLD' ? wo.supportedUnit : wo.supportedUnit;
      const dest   = wo.type === 'SUPPORT_MOVE'  ? wo.supportedDestination : null;
      const supportedOrder = working.find(o =>
        o.unitTerritory === target &&
        (wo.type === 'SUPPORT_HOLD'
          ? (o.type === 'HOLD' || o.type === 'SUPPORT_HOLD' || o.type === 'SUPPORT_MOVE')
          : (o.type === 'MOVE' && o.targetTerritory === dest))
      );
      if (supportedOrder) supportedOrder.supportCount++;
    }
  }

  // --- Phase 2: Cut supports ---
  for (const attacker of working) {
    if (attacker.type !== 'MOVE') continue;
    const defender = working.find(
      o => o.unitTerritory === attacker.targetTerritory &&
           (o.type === 'SUPPORT_HOLD' || o.type === 'SUPPORT_MOVE')
    );
    if (!defender) continue;

    // Support is NOT cut if attacker comes from the territory being supported against
    const supportTarget =
      defender.type === 'SUPPORT_HOLD' ? defender.supportedUnit : defender.supportedDestination;
    if (attacker.unitTerritory === supportTarget) continue;

    // Support is cut — reduce count of the order being supported
    const supportedOrder = working.find(o =>
      o.unitTerritory === (defender.type === 'SUPPORT_HOLD' ? defender.supportedUnit : defender.supportedUnit)
    );
    if (supportedOrder && supportedOrder.supportCount > 0) {
      supportedOrder.supportCount--;
    }
    defender.resolution = 'CUT';
    defender.reason = `Support cut by attack from ${attacker.unitTerritory}`;
  }

  // --- Phase 3: Iterative resolution ---
  let changed = true;
  while (changed) {
    changed = false;
    for (const wo of working) {
      if (wo.resolution !== 'UNRESOLVED') continue;

      if (wo.type === 'HOLD' || wo.type === 'SUPPORT_HOLD' || wo.type === 'SUPPORT_MOVE' || wo.type === 'CONVOY') {
        // These don't move — they succeed or fail based on whether they're dislodged
        // (dislodgement is handled in index.ts, not here)
        // For now mark as SUCCEEDS unless cut
        if (wo.resolution === 'UNRESOLVED') {
          wo.resolution = 'SUCCEEDS';
          wo.reason = 'Default success';
          changed = true;
        }
        continue;
      }

      if (wo.type === 'MOVE') {
        const result = tryResolveMove(wo, working, state);
        if (result !== 'UNRESOLVED') {
          wo.resolution = result.resolution;
          wo.reason = result.reason;
          changed = true;
        }
      }
    }
  }

  // --- Phase 4: Handle remaining unresolved (circular movements) ---
  const unresolved = working.filter(o => o.resolution === 'UNRESOLVED');
  if (unresolved.length > 0) {
    const rotationMembers = detectCircularMovement(unresolved, working);
    for (const wo of unresolved) {
      if (rotationMembers.has(wo.unitTerritory)) {
        wo.resolution = 'SUCCEEDS';
        wo.reason = 'Circular movement — all rotate';
      } else {
        wo.resolution = 'FAILS';
        wo.reason = 'Could not be resolved';
      }
    }
  }

  return working.map(wo => ({
    ...wo,
    resolution: wo.resolution as OrderResolution,
  }));
}

function tryResolveMove(
  move: WorkingOrder,
  all: WorkingOrder[],
  state: GameState
): { resolution: Resolution; reason: string } | 'UNRESOLVED' {
  const { targetTerritory } = move;
  if (!targetTerritory) return { resolution: 'FAILS', reason: 'No target territory' };

  // Check if this move has a valid path (direct or convoy)
  const hasDirectPath = hasDirectAdj(move, state);
  const hasConvoyPath = !hasDirectPath && hasConvoy(move, all, state);

  if (!hasDirectPath && !hasConvoyPath) {
    return { resolution: 'VOID', reason: 'No valid path to target' };
  }

  // Compute attack strength = 1 (mover) + uncut supports
  const attackStrength = 1 + move.supportCount;

  // Find all other attackers targeting the same territory
  const rivals = all.filter(
    o => o.type === 'MOVE' && o.targetTerritory === targetTerritory && o.unitTerritory !== move.unitTerritory
  );

  // Is there a stationary defender?
  const defender = state.units.find(
    u => u.territory === targetTerritory && u.power !== move.power
  );
  const defenderOrder = all.find(o => o.unitTerritory === targetTerritory);

  let defenseStrength = 0;
  if (defender) {
    const defIsMovingOut = defenderOrder?.type === 'MOVE' && defenderOrder.resolution === 'SUCCEEDS';
    if (defIsMovingOut) {
      defenseStrength = 0; // Territory will be vacated
    } else if (defenderOrder?.resolution === 'UNRESOLVED' && defenderOrder?.type === 'MOVE') {
      return 'UNRESOLVED'; // Wait for defender's move to resolve
    } else {
      defenseStrength = 1 + (defenderOrder?.supportCount ?? 0);
    }
  }

  // Check if any rival's resolution is still unknown
  const rivalUnresolved = rivals.some(r => r.resolution === 'UNRESOLVED');
  if (rivalUnresolved) return 'UNRESOLVED';

  const rivalMaxStrength = rivals.reduce(
    (max, r) => Math.max(max, 1 + r.supportCount),
    0
  );

  if (attackStrength > defenseStrength && attackStrength > rivalMaxStrength) {
    return { resolution: 'SUCCEEDS', reason: `Attack strength ${attackStrength} overcomes defense ${defenseStrength}` };
  }

  if (rivals.some(r => r.resolution !== 'FAILS' && 1 + r.supportCount >= attackStrength)) {
    return { resolution: 'BOUNCED', reason: 'Bounced by rival attacker' };
  }

  if (attackStrength <= defenseStrength) {
    return { resolution: 'FAILS', reason: `Attack strength ${attackStrength} insufficient against defense ${defenseStrength}` };
  }

  return 'UNRESOLVED';
}

function hasDirectAdj(move: WorkingOrder, state: GameState): boolean {
  const unit = state.units.find(u => u.territory === move.unitTerritory);
  if (!unit) return false;

  if (unit.type === 'ARMY') {
    return getArmyAdjacency(move.unitTerritory).includes(move.targetTerritory!);
  } else {
    return getFleetAdjacency(move.unitTerritory, unit.coast).includes(move.targetTerritory!);
  }
}

function hasConvoy(move: WorkingOrder, all: WorkingOrder[], state: GameState): boolean {
  const unit = state.units.find(u => u.territory === move.unitTerritory);
  if (!unit || unit.type !== 'ARMY') return false;
  const paths = findConvoyPaths(move.unitTerritory, move.targetTerritory!, all);
  return paths.length > 0;
}

/** Detect purely circular rotations (A→B, B→C, C→A) among unresolved moves */
function detectCircularMovement(unresolved: WorkingOrder[], all: WorkingOrder[]): Set<string> {
  const moveMap = new Map<string, string>();
  for (const o of all) {
    if (o.type === 'MOVE' && o.targetTerritory) {
      moveMap.set(o.unitTerritory, o.targetTerritory);
    }
  }

  const inRotation = new Set<string>();
  for (const start of unresolved) {
    const visited = new Set<string>();
    let current: string | undefined = start.unitTerritory;
    while (current && !visited.has(current)) {
      visited.add(current);
      current = moveMap.get(current);
    }
    if (current && visited.has(current)) {
      // Found a cycle — mark all members
      let node: string | undefined = current;
      do {
        inRotation.add(node!);
        node = moveMap.get(node!);
      } while (node && node !== current);
    }
  }

  return inRotation;
}
