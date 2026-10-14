import type { Power, PublicPhaseReport, TerritoryId, Unit } from '@diplomacy/shared';
import { ADJACENCY, TERRITORIES } from '@diplomacy/shared';

export const POWER_COLORS: Record<Power, string> = {
  AUSTRIA: '#d94f4f',
  ENGLAND: '#7a5bd8',
  FRANCE: '#3b82f6',
  GERMANY: '#6b7280',
  ITALY: '#22a06b',
  RUSSIA: '#f5f5f4',
  TURKEY: '#d89b2b',
};

export const TERRITORY_BY_ID = Object.fromEntries(TERRITORIES.map(territory => [territory.id, territory]));

export function territoryName(id: TerritoryId): string {
  return TERRITORY_BY_ID[id]?.name ?? id;
}

export function territoryLabel(id: TerritoryId): string {
  return `${id} - ${territoryName(id)}`;
}

export function unitLabel(unit: Unit): string {
  const coast = unit.coast ? `/${unit.coast}` : '';
  return `${unit.type[0]} ${unit.power} ${unit.territory}${coast}`;
}

export function adjacentTerritories(unit: Unit): TerritoryId[] {
  const entry = ADJACENCY[unit.territory];
  if (!entry) return [];
  if (unit.type === 'ARMY') return entry.army;
  if (Array.isArray(entry.fleet)) return entry.fleet;
  if (unit.coast) return entry.fleet[unit.coast] ?? [];
  return [...new Set(Object.values(entry.fleet).flat())];
}

export function convoyDestinations(unit: Unit, units: Unit[]): TerritoryId[] {
  if (unit.type !== 'ARMY' || TERRITORY_BY_ID[unit.territory]?.type !== 'COASTAL') return [];

  const fleetSeas = new Set(
    convoyFleets(unit, units).map(candidate => candidate.territory)
  );
  if (fleetSeas.size === 0) return [];

  const queue = fleetNeighbors(unit.territory).filter(territory => fleetSeas.has(territory));
  const reachableSeas = new Set<TerritoryId>(queue);

  for (let index = 0; index < queue.length; index += 1) {
    const sea = queue[index];
    for (const neighbor of fleetNeighbors(sea)) {
      if (!fleetSeas.has(neighbor) || reachableSeas.has(neighbor)) continue;
      reachableSeas.add(neighbor);
      queue.push(neighbor);
    }
  }

  const destinations = new Set<TerritoryId>();
  for (const sea of reachableSeas) {
    for (const neighbor of fleetNeighbors(sea)) {
      if (
        neighbor !== unit.territory &&
        TERRITORY_BY_ID[neighbor]?.type === 'COASTAL'
      ) {
        destinations.add(neighbor);
      }
    }
  }
  return [...destinations].sort();
}

export function convoyRoute(unit: Unit, units: Unit[], destination: TerritoryId): Unit[] {
  if (
    unit.type !== 'ARMY' ||
    TERRITORY_BY_ID[unit.territory]?.type !== 'COASTAL' ||
    TERRITORY_BY_ID[destination]?.type !== 'COASTAL' ||
    destination === unit.territory
  ) {
    return [];
  }

  const fleetBySea = new Map(
    convoyFleets(unit, units).map(fleet => [fleet.territory, fleet])
  );
  const queue = fleetNeighbors(unit.territory).filter(territory => fleetBySea.has(territory));
  const previous = new Map<TerritoryId, TerritoryId | null>(
    queue.map(territory => [territory, null])
  );

  for (let index = 0; index < queue.length; index += 1) {
    const sea = queue[index];
    if (fleetNeighbors(sea).includes(destination)) {
      const route: Unit[] = [];
      let current: TerritoryId | null = sea;
      while (current) {
        const fleet = fleetBySea.get(current);
        if (fleet) route.unshift(fleet);
        current = previous.get(current) ?? null;
      }
      return route;
    }

    for (const neighbor of fleetNeighbors(sea)) {
      if (!fleetBySea.has(neighbor) || previous.has(neighbor)) continue;
      previous.set(neighbor, sea);
      queue.push(neighbor);
    }
  }

  return [];
}

function convoyFleets(unit: Unit, units: Unit[]): Unit[] {
  return units.filter(candidate =>
    candidate.type === 'FLEET' &&
    candidate.power === unit.power &&
    !candidate.mustRetreat &&
    TERRITORY_BY_ID[candidate.territory]?.type === 'SEA'
  );
}

function fleetNeighbors(territory: TerritoryId): TerritoryId[] {
  const fleet = ADJACENCY[territory]?.fleet;
  if (!fleet) return [];
  if (Array.isArray(fleet)) return fleet;
  return [...new Set(Object.values(fleet).flat())];
}

/**
 * Which power's unit last stood on each land province without a supply center: from the board
 * before and after each resolved phase given, then the units on the board shown. The map shades
 * these lightly, so the area each power controls reads as one region between its centers. Seas are
 * left out: a fleet passing through does not make a sea anyone's.
 */
export function heldTerritories(reports: readonly PublicPhaseReport[], shown: readonly Unit[] | null | undefined): Partial<Record<TerritoryId, Power>> {
  const held: Partial<Record<TerritoryId, Power>> = {};
  const mark = (units: readonly Unit[]) => {
    for (const unit of units) {
      const territory = TERRITORY_BY_ID[unit.territory];
      if (territory && !territory.isSupplyCenter && territory.type !== 'SEA') held[unit.territory] = unit.power;
    }
  };
  for (const report of reports) { mark(report.before.units); mark(report.after.units); }
  if (shown) mark(shown);
  return held;
}
