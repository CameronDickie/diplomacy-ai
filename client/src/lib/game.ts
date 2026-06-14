import type { Power, TerritoryId, Unit } from '@diplomacy/shared';
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
