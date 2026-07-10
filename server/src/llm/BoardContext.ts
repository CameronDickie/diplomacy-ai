import type {
  Coast,
  GameState,
  Power,
  TerritoryId,
  TerritoryType,
  UnitType,
} from '@diplomacy/shared';
import {
  ADJACENCY,
  ALL_POWERS,
  TERRITORIES,
  getArmyAdjacency,
  getFleetAdjacency,
} from '@diplomacy/shared';

export const BOARD_CONTEXT_VERSION = 'standard-board-v1';

export interface LlmBoardContext {
  version: typeof BOARD_CONTEXT_VERSION;
  rulesReference: Array<{
    id: TerritoryId;
    name: string;
    type: TerritoryType;
    isSupplyCenter: boolean;
    homePower: Power | null;
    coasts: Coast[];
    armyAdjacent: TerritoryId[];
    fleetAdjacent: TerritoryId[] | Partial<Record<Coast, TerritoryId[]>>;
  }>;
  position: {
    units: Array<{
      id: string;
      power: Power;
      type: UnitType;
      territory: TerritoryId;
      coast: Coast | null;
      mustRetreat: boolean;
    }>;
    supplyCenters: Array<{
      territory: TerritoryId;
      owner: Power | null;
      homePower: Power | null;
      occupiedBy: Power | null;
    }>;
    pendingFallCaptures: Array<{
      territory: TerritoryId;
      currentOwner: Power | null;
      occupyingPower: Power;
    }>;
    powerSummaries: Array<{
      power: Power;
      unitCount: number;
      supplyCenterCount: number;
      buildBalance: number;
    }>;
    adjustmentByPower: Array<{
      power: Power;
      balance: number;
      legalBuildSites: Array<{
        territory: TerritoryId;
        unitTypes: UnitType[];
        fleetCoasts: Coast[];
      }>;
    }>;
    directMovementByUnit: Array<{
      unitId: string;
      power: Power;
      source: TerritoryId;
      destinations: TerritoryId[];
    }>;
  };
}

const RULES_REFERENCE: LlmBoardContext['rulesReference'] = TERRITORIES
  .map(territory => ({
    id: territory.id,
    name: territory.name,
    type: territory.type,
    isSupplyCenter: territory.isSupplyCenter,
    homePower: territory.homePower,
    coasts: [...territory.coasts],
    armyAdjacent: [...ADJACENCY[territory.id].army],
    fleetAdjacent: cloneFleetAdjacency(ADJACENCY[territory.id].fleet),
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

export function buildLlmBoardContext(state: GameState): LlmBoardContext {
  const activeOccupiers = new Map(
    state.units
      .filter(unit => !unit.mustRetreat)
      .map(unit => [unit.territory, unit.power])
  );
  const supplyCenters = TERRITORIES
    .filter(territory => territory.isSupplyCenter)
    .map(territory => ({
      territory: territory.id,
      owner: state.territories[territory.id]?.owner ?? null,
      homePower: territory.homePower,
      occupiedBy: activeOccupiers.get(territory.id) ?? null,
    }))
    .sort((left, right) => left.territory.localeCompare(right.territory));

  return {
    version: BOARD_CONTEXT_VERSION,
    rulesReference: RULES_REFERENCE,
    position: {
      units: state.units
        .map(unit => ({
          id: unit.id,
          power: unit.power,
          type: unit.type,
          territory: unit.territory,
          coast: unit.coast,
          mustRetreat: unit.mustRetreat,
        }))
        .sort((left, right) =>
          left.power.localeCompare(right.power) ||
          left.territory.localeCompare(right.territory)
        ),
      supplyCenters,
      pendingFallCaptures: state.season === 'FALL'
        ? supplyCenters
            .filter(center =>
              center.occupiedBy !== null &&
              center.occupiedBy !== center.owner
            )
            .map(center => ({
              territory: center.territory,
              currentOwner: center.owner,
              occupyingPower: center.occupiedBy!,
            }))
        : [],
      powerSummaries: ALL_POWERS.map(power => {
        const unitCount = state.units.filter(unit => unit.power === power).length;
        const supplyCenterCount = supplyCenters.filter(center => center.owner === power).length;
        return {
          power,
          unitCount,
          supplyCenterCount,
          buildBalance: supplyCenterCount - unitCount,
        };
      }),
      adjustmentByPower: ALL_POWERS.map(power => {
        const unitCount = state.units.filter(unit => unit.power === power).length;
        const supplyCenterCount = supplyCenters.filter(center => center.owner === power).length;
        return {
          power,
          balance: supplyCenterCount - unitCount,
          legalBuildSites: TERRITORIES
            .filter(territory =>
              territory.isSupplyCenter &&
              territory.homePower === power &&
              state.territories[territory.id]?.owner === power &&
              !activeOccupiers.has(territory.id)
            )
            .map(territory => ({
              territory: territory.id,
              unitTypes: territory.type === 'LAND'
                ? ['ARMY' as const]
                : ['ARMY' as const, 'FLEET' as const],
              fleetCoasts: [...territory.coasts],
            }))
            .sort((left, right) => left.territory.localeCompare(right.territory)),
        };
      }),
      directMovementByUnit: state.units
        .filter(unit => !unit.mustRetreat)
        .map(unit => ({
          unitId: unit.id,
          power: unit.power,
          source: unit.territory,
          destinations: (
            unit.type === 'ARMY'
              ? getArmyAdjacency(unit.territory)
              : getFleetAdjacency(unit.territory, unit.coast)
          ).slice().sort(),
        }))
        .sort((left, right) =>
          left.power.localeCompare(right.power) ||
          left.source.localeCompare(right.source)
        ),
    },
  };
}

function cloneFleetAdjacency(
  adjacency: TerritoryId[] | Partial<Record<Coast, TerritoryId[]>>
): TerritoryId[] | Partial<Record<Coast, TerritoryId[]>> {
  if (Array.isArray(adjacency)) return [...adjacency];
  return Object.fromEntries(
    Object.entries(adjacency).map(([coast, territories]) => [
      coast,
      [...(territories ?? [])],
    ])
  );
}
