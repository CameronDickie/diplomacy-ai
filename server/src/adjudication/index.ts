import type { GameState, Order, AdjudicationResult, Unit } from '@diplomacy/shared';
import { validateOrders } from './OrderValidator.js';
import { resolveMoves } from './MoveResolver.js';
import { ADJACENCY } from '@diplomacy/shared';

export function adjudicate(state: GameState, orders: Order[]): AdjudicationResult {
  // 1. Validate all orders (illegals become HOLDs)
  const validatedOrders = validateOrders(orders, state);

  // 2. Resolve all orders
  const resolvedOrders = resolveMoves(validatedOrders, state);

  // 3. Identify dislodged units
  const successfulMoves = resolvedOrders.filter(
    o => o.type === 'MOVE' && o.resolution === 'SUCCEEDS'
  );

  const dislodgedUnits: Unit[] = [];
  const destroyedUnits: Unit[] = [];
  const standoffTerritories: string[] = [];

  // Collect standoff territories (where moves bounced — multiple units tried to move here)
  const movedTo = new Map<string, number>();
  for (const order of resolvedOrders) {
    if (order.type === 'MOVE' && order.targetTerritory) {
      movedTo.set(order.targetTerritory, (movedTo.get(order.targetTerritory) ?? 0) + 1);
    }
  }
  for (const [territory, count] of movedTo) {
    if (count > 1) {
      const anySucceeded = successfulMoves.some(o => o.targetTerritory === territory);
      if (!anySucceeded) standoffTerritories.push(territory);
    }
  }

  // Compute where units will be AFTER moves resolve
  const finalPositions = new Map<string, string>(); // unitId → finalTerritory
  for (const unit of state.units) {
    finalPositions.set(unit.id, unit.territory);
  }
  for (const move of successfulMoves) {
    const unit = state.units.find(u => u.territory === move.unitTerritory);
    if (unit) finalPositions.set(unit.id, move.targetTerritory!);
  }

  // Find dislodged units
  for (const move of successfulMoves) {
    const defender = state.units.find(
      u => u.territory === move.targetTerritory && u.power !== move.power
    );
    if (!defender) continue;

    const defenderFinalPos = finalPositions.get(defender.id)!;
    // Defender was dislodged only if they're still "at" the target after moves
    if (defenderFinalPos === move.targetTerritory) {
      // Compute valid retreat destinations
      const adjEntry = ADJACENCY[move.targetTerritory!];
      const allAdj: string[] = adjEntry
        ? [
            ...adjEntry.army,
            ...(Array.isArray(adjEntry.fleet)
              ? adjEntry.fleet
              : Object.values(adjEntry.fleet).flat()),
          ]
        : [];
      const uniqueAdj = [...new Set(allAdj)];

      const retreatOptions = uniqueAdj.filter(t => {
        // Must be empty after all moves resolve
        const occupiedAfterMoves = [...finalPositions.values()].filter(
          (pos, _, arr) => pos === t && arr.indexOf(pos) !== arr.lastIndexOf(pos) // skip defender
        );
        void occupiedAfterMoves;

        // Can't retreat to the territory the attacker came from
        if (t === move.unitTerritory) return false;
        // Can't retreat to a standoff territory
        if (standoffTerritories.includes(t)) return false;
        // Can't retreat to an occupied territory
        const currentlyOccupied = [...finalPositions.values()].includes(t);
        if (currentlyOccupied) return false;

        return true;
      });

      const dislodgedUnit: Unit = {
        ...defender,
        mustRetreat: true,
        retreatOptions,
        dislodgedBy: move.unitTerritory,
      };

      if (retreatOptions.length === 0) {
        destroyedUnits.push(dislodgedUnit);
      } else {
        dislodgedUnits.push(dislodgedUnit);
      }
    }
  }

  return {
    resolvedOrders,
    dislodgedUnits,
    destroyedUnits,
    newTerritoryOwnership: {},
    buildCounts: {} as Record<string, number>,
    standoffTerritories,
  };
}
