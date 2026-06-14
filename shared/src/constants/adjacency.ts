import type { TerritoryId } from '../types/territory.js';
import { ADJACENCY } from './adjacency.generated.js';

export { ADJACENCY };
export type { AdjacencyEntry } from './adjacency.generated.js';

export function getFleetAdjacency(
  territory: TerritoryId,
  coast?: string | null
): TerritoryId[] {
  const entry = ADJACENCY[territory];
  if (!entry) return [];
  if (Array.isArray(entry.fleet)) return entry.fleet;
  if (coast && coast in entry.fleet) {
    return (entry.fleet as Record<string, TerritoryId[]>)[coast] ?? [];
  }
  return [...new Set(Object.values(entry.fleet).flat())];
}

export function getArmyAdjacency(territory: TerritoryId): TerritoryId[] {
  return ADJACENCY[territory]?.army ?? [];
}
