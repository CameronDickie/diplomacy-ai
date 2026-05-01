import type { GameState, Order, Unit } from '@diplomacy/shared';
import { ADJACENCY, TERRITORY_MAP, getArmyAdjacency, getFleetAdjacency } from '@diplomacy/shared';

/**
 * Validates all submitted orders and converts illegal ones to HOLD.
 * Returns a new array of normalized orders — one per unit.
 * Any unit without a submitted order gets a HOLD.
 */
export function validateOrders(orders: Order[], state: GameState): Order[] {
  const orderByTerritory = new Map<string, Order>();
  for (const order of orders) {
    orderByTerritory.set(order.unitTerritory, order);
  }

  const result: Order[] = [];

  for (const unit of state.units) {
    const order = orderByTerritory.get(unit.territory);
    if (!order) {
      result.push(makeHold(unit));
      continue;
    }

    const validated = validateSingleOrder(order, unit, state);
    result.push(validated);
  }

  return result;
}

function validateSingleOrder(order: Order, unit: Unit, state: GameState): Order {
  switch (order.type) {
    case 'HOLD':
      return order;

    case 'MOVE':
      return validateMove(order, unit, state);

    case 'SUPPORT_HOLD':
      return validateSupportHold(order, unit, state);

    case 'SUPPORT_MOVE':
      return validateSupportMove(order, unit, state);

    case 'CONVOY':
      return validateConvoy(order, unit, state);

    default:
      return makeHold(unit);
  }
}

function validateMove(order: Order, unit: Unit, state: GameState): Order {
  if (!order.targetTerritory) return makeHold(unit);

  const destTerritoryDef = TERRITORY_MAP[order.targetTerritory];
  if (!destTerritoryDef) return makeHold(unit);

  // Can't stay in same territory
  if (order.targetTerritory === unit.territory) return makeHold(unit);

  if (unit.type === 'ARMY') {
    // Armies cannot move to sea zones
    if (destTerritoryDef.type === 'SEA') return makeHold(unit);
    // Check land adjacency (armies can also move via convoy, validated separately)
    const adjLand = getArmyAdjacency(unit.territory);
    if (!adjLand.includes(order.targetTerritory)) {
      // Could be a convoy move — mark as MOVE and let ConvoyResolver validate
      // For now, allow it (convoy paths checked during adjudication)
    }
  } else {
    // Fleets cannot move to inland territories
    if (destTerritoryDef.type === 'LAND') return makeHold(unit);
    // Check fleet adjacency (with coast if applicable)
    const adjFleet = getFleetAdjacency(unit.territory, unit.coast);
    if (!adjFleet.includes(order.targetTerritory)) return makeHold(unit);
  }

  return order;
}

function validateSupportHold(order: Order, unit: Unit, state: GameState): Order {
  if (!order.supportedUnit) return makeHold(unit);

  // The supported unit must exist
  const supportedExists = state.units.some(u => u.territory === order.supportedUnit);
  if (!supportedExists) return makeHold(unit);

  // The supporting unit must be adjacent to the supported territory
  const adj = unit.type === 'ARMY'
    ? getArmyAdjacency(unit.territory)
    : getFleetAdjacency(unit.territory, unit.coast);

  if (!adj.includes(order.supportedUnit!)) return makeHold(unit);

  return order;
}

function validateSupportMove(order: Order, unit: Unit, state: GameState): Order {
  if (!order.supportedUnit || !order.supportedDestination) return makeHold(unit);

  // The supported unit must exist
  const supportedUnit = state.units.find(u => u.territory === order.supportedUnit);
  if (!supportedUnit) return makeHold(unit);

  // The supporting unit must be adjacent to the destination
  const adj = unit.type === 'ARMY'
    ? getArmyAdjacency(unit.territory)
    : getFleetAdjacency(unit.territory, unit.coast);

  if (!adj.includes(order.supportedDestination)) return makeHold(unit);

  return order;
}

function validateConvoy(order: Order, unit: Unit, state: GameState): Order {
  // Only fleets in sea territories can convoy
  if (unit.type !== 'FLEET') return makeHold(unit);

  const territoryDef = TERRITORY_MAP[unit.territory];
  if (!territoryDef || territoryDef.type !== 'SEA') return makeHold(unit);

  if (!order.supportedUnit || !order.targetTerritory) return makeHold(unit);

  // The army being convoyed must exist
  const armyExists = state.units.some(
    u => u.territory === order.supportedUnit && u.type === 'ARMY'
  );
  if (!armyExists) return makeHold(unit);

  return order;
}

export function makeHold(unit: Unit): Order {
  return {
    id: `hold-${unit.id}`,
    power: unit.power,
    unitTerritory: unit.territory,
    unitCoast: unit.coast,
    type: 'HOLD',
    targetTerritory: null,
    targetCoast: null,
    supportedUnit: null,
    supportedDestination: null,
  };
}
