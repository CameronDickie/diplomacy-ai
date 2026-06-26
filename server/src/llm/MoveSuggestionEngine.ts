import { randomUUID } from 'crypto';
import type {
  Coast,
  GameState,
  Order,
  Power,
  TerritoryId,
  Unit,
} from '@diplomacy/shared';
import {
  getArmyAdjacency,
  getFleetAdjacency,
  TERRITORY_MAP,
} from '@diplomacy/shared';

export interface MoveSuggestion {
  id: string;
  score: number;
  rationale: string;
  orders: Order[];
}

export function suggestMoveOrderSets(
  state: GameState,
  power: Power,
  maxSuggestions = 8
): MoveSuggestion[] {
  const units = state.units.filter(unit => unit.power === power && !unit.mustRetreat);
  if (units.length === 0) return [];

  const suggestions: MoveSuggestion[] = [{
    id: suggestionId(state, power, 'hold-all'),
    score: 0,
    rationale: 'Hold every active unit.',
    orders: holdOrders(power, units),
  }];

  for (const unit of units) {
    for (const destination of directDestinations(unit)) {
      suggestions.push(moveOneUnitSuggestion(state, power, units, unit, destination, false));
    }
    for (const destination of convoyDestinations(state, power, unit)) {
      suggestions.push(moveOneUnitSuggestion(state, power, units, unit, destination, true));
    }
    for (const supported of units) {
      if (supported.id === unit.id) continue;
      if (!directDestinations(unit).includes(supported.territory)) continue;
      suggestions.push(supportHoldSuggestion(state, power, units, unit, supported));
    }
  }

  return suggestions
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, maxSuggestions);
}

function moveOneUnitSuggestion(
  state: GameState,
  power: Power,
  units: Unit[],
  unit: Unit,
  destination: TerritoryId,
  viaConvoy: boolean
): MoveSuggestion {
  const orders = holdOrders(power, units).map(order =>
    order.unitTerritory === unit.territory
      ? {
          ...order,
          type: 'MOVE' as const,
          targetTerritory: destination,
          targetCoast: null,
          viaConvoy,
        }
      : order
  );
  const convoyOrders = viaConvoy
    ? convoyRoute(state, power, unit, destination).map(fleet => ({
        id: randomUUID(),
        power,
        unitTerritory: fleet.territory,
        unitCoast: fleet.coast as Coast | null,
        type: 'CONVOY' as const,
        targetTerritory: destination,
        targetCoast: null,
        supportedUnit: unit.territory,
        supportedDestination: null,
      }))
    : [];
  return {
    id: suggestionId(
      state,
      power,
      viaConvoy
        ? `convoy-${unit.territory}-${destination}`
        : `move-${unit.territory}-${destination}`
    ),
    score: scoreDestination(state, power, destination) + (viaConvoy ? 1 : 0),
    rationale: `${unit.type} ${unit.territory} moves to ${destination}${viaConvoy ? ' by convoy' : ''}.`,
    orders: mergeOrders(orders, convoyOrders),
  };
}

function supportHoldSuggestion(
  state: GameState,
  power: Power,
  units: Unit[],
  supporter: Unit,
  supported: Unit
): MoveSuggestion {
  const orders = holdOrders(power, units).map(order =>
    order.unitTerritory === supporter.territory
      ? {
          ...order,
          type: 'SUPPORT_HOLD' as const,
          supportedUnit: supported.territory,
        }
      : order
  );
  return {
    id: suggestionId(state, power, `support-hold-${supporter.territory}-${supported.territory}`),
    score: 1 + scoreDestination(state, power, supported.territory) / 2,
    rationale: `${supporter.type} ${supporter.territory} supports ${supported.territory} to hold.`,
    orders,
  };
}

function holdOrders(power: Power, units: Unit[]): Order[] {
  return units.map(unit => ({
    id: randomUUID(),
    power,
    unitTerritory: unit.territory,
    unitCoast: unit.coast as Coast | null,
    type: 'HOLD',
    targetTerritory: null,
    targetCoast: null,
    supportedUnit: null,
    supportedDestination: null,
  }));
}

function mergeOrders(base: Order[], overrides: Order[]): Order[] {
  const byTerritory = new Map(base.map(order => [order.unitTerritory, order]));
  for (const order of overrides) byTerritory.set(order.unitTerritory, order);
  return [...byTerritory.values()];
}

function directDestinations(unit: Unit): TerritoryId[] {
  return unit.type === 'ARMY'
    ? getArmyAdjacency(unit.territory)
    : getFleetAdjacency(unit.territory, unit.coast);
}

function scoreDestination(
  state: GameState,
  power: Power,
  destination: TerritoryId
): number {
  const territory = state.territories[destination];
  if (!territory?.isSupplyCenter) return 1;
  if (territory.owner === power) return 2;
  if (!territory.owner) return 5;
  return 6;
}

function convoyDestinations(
  state: GameState,
  power: Power,
  unit: Unit
): TerritoryId[] {
  if (unit.type !== 'ARMY') return [];
  const landAdjacent = new Set(getArmyAdjacency(unit.territory));
  return convoyRouteDestinations(state, power, unit.territory)
    .filter(destination => !landAdjacent.has(destination));
}

function convoyRoute(
  state: GameState,
  power: Power,
  unit: Unit,
  destination: TerritoryId
): Unit[] {
  if (unit.type !== 'ARMY') return [];
  return findConvoyRoute(state, power, unit.territory, destination) ?? [];
}

function convoyRouteDestinations(
  state: GameState,
  power: Power,
  source: TerritoryId
): TerritoryId[] {
  const fleetTerritories = ownSeaFleetTerritories(state, power);
  const destinations = new Set<TerritoryId>();
  for (const sea of reachableFleetSeas(source, fleetTerritories)) {
    for (const destination of getFleetAdjacency(sea)) {
      if (TERRITORY_MAP[destination]?.type !== 'SEA') destinations.add(destination);
    }
  }
  destinations.delete(source);
  return [...destinations].sort();
}

function findConvoyRoute(
  state: GameState,
  power: Power,
  source: TerritoryId,
  destination: TerritoryId
): Unit[] | null {
  const fleets = state.units.filter(
    unit =>
      unit.power === power &&
      unit.type === 'FLEET' &&
      TERRITORY_MAP[unit.territory]?.type === 'SEA' &&
      !unit.mustRetreat
  );
  const fleetByTerritory = new Map(fleets.map(fleet => [fleet.territory, fleet]));
  const fleetTerritories = new Set(fleetByTerritory.keys());
  const queue = getFleetAdjacency(source)
    .filter(territory => fleetTerritories.has(territory))
    .map(territory => ({ territory, path: [territory] }));
  const visited = new Set<TerritoryId>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.territory)) continue;
    visited.add(current.territory);
    if (getFleetAdjacency(current.territory).includes(destination)) {
      return current.path
        .map(territory => fleetByTerritory.get(territory))
        .filter((fleet): fleet is Unit => Boolean(fleet));
    }
    for (const next of getFleetAdjacency(current.territory)) {
      if (!fleetTerritories.has(next) || visited.has(next)) continue;
      queue.push({ territory: next, path: [...current.path, next] });
    }
  }
  return null;
}

function reachableFleetSeas(
  source: TerritoryId,
  fleetTerritories: Set<TerritoryId>
): TerritoryId[] {
  const queue = getFleetAdjacency(source).filter(territory => fleetTerritories.has(territory));
  const visited = new Set<TerritoryId>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of getFleetAdjacency(current)) {
      if (fleetTerritories.has(next) && !visited.has(next)) queue.push(next);
    }
  }
  return [...visited];
}

function ownSeaFleetTerritories(state: GameState, power: Power): Set<TerritoryId> {
  return new Set(
    state.units
      .filter(unit =>
        unit.power === power &&
        unit.type === 'FLEET' &&
        TERRITORY_MAP[unit.territory]?.type === 'SEA' &&
        !unit.mustRetreat
      )
      .map(unit => unit.territory)
  );
}

function suggestionId(
  state: GameState,
  power: Power,
  suffix: string
): string {
  return [
    'advisor',
    state.year,
    state.season.toLowerCase(),
    power.toLowerCase(),
    suffix.toLowerCase(),
  ].join('-');
}

