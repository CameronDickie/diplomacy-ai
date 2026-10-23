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

export function adjacentTerritories(unit: Unit): TerritoryId[] {
  const entry = ADJACENCY[unit.territory];
  if (!entry) return [];
  if (unit.type === 'ARMY') return entry.army;
  if (Array.isArray(entry.fleet)) return entry.fleet;
  if (unit.coast) return entry.fleet[unit.coast] ?? [];
  return [...new Set(Object.values(entry.fleet).flat())];
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
