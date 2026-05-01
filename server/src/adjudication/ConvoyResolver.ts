import type { Order } from '@diplomacy/shared';
import { TERRITORY_MAP, ADJACENCY } from '@diplomacy/shared';

interface WorkingOrder extends Order {
  resolution: string;
}

/**
 * BFS to find all valid convoy paths for an army moving from `origin` to `dest`.
 * A valid path is a chain of fleets in sea territories each with a CONVOY order
 * for this specific move AND whose CONVOY order has not already failed.
 */
export function findConvoyPaths(
  origin: string,
  dest: string,
  orders: WorkingOrder[],
): string[][] {
  const convoyingFleets = new Set<string>(
    orders
      .filter(
        o =>
          o.type === 'CONVOY' &&
          o.supportedUnit === origin &&
          o.targetTerritory === dest &&
          o.resolution !== 'FAILS' &&
          o.resolution !== 'BOUNCED' &&
          o.resolution !== 'VOID'
      )
      .map(o => o.unitTerritory)
  );

  if (convoyingFleets.size === 0) return [];

  const destDef = TERRITORY_MAP[dest];
  if (!destDef || destDef.type === 'SEA') return [];

  const originSeaNeighbors = getSeaNeighbors(origin);

  type PathState = { territory: string; path: string[] };
  const queue: PathState[] = originSeaNeighbors
    .filter(t => convoyingFleets.has(t))
    .map(t => ({ territory: t, path: [t] }));

  const paths: string[][] = [];

  while (queue.length > 0) {
    const { territory, path } = queue.shift()!;
    const adj = getSeaAndCoastalNeighbors(territory);

    for (const next of adj) {
      if (next === dest) {
        paths.push([...path]);
        continue;
      }
      if (!convoyingFleets.has(next)) continue;
      if (path.includes(next)) continue;
      queue.push({ territory: next, path: [...path, next] });
    }
  }

  return paths;
}

function getSeaNeighbors(territory: string): string[] {
  const entry = ADJACENCY[territory];
  if (!entry) return [];
  const fleet = Array.isArray(entry.fleet)
    ? entry.fleet
    : Object.values(entry.fleet as Record<string, string[]>).flat();
  return fleet.filter(t => TERRITORY_MAP[t]?.type === 'SEA');
}

function getSeaAndCoastalNeighbors(seaTerritory: string): string[] {
  const entry = ADJACENCY[seaTerritory];
  if (!entry) return [];
  return Array.isArray(entry.fleet)
    ? (entry.fleet as string[])
    : Object.values(entry.fleet as Record<string, string[]>).flat();
}
