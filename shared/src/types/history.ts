import type { Phase, Power, Season } from './game.js';
import type { ResolvedOrder } from './order.js';
import type { Coast, TerritoryId } from './territory.js';
import type { Unit, UnitType } from './unit.js';

export interface PublicBoardSnapshot {
  units: Unit[];
  territoryOwners: Record<TerritoryId, Power | null>;
}

interface BasePhaseReport {
  id: string;
  sequence: number;
  year: number;
  season: Season;
  phase: Phase;
  resolvedAt: string;
  before: PublicBoardSnapshot;
  after: PublicBoardSnapshot;
}

export interface OrdersPhaseReport extends BasePhaseReport {
  phase: 'ORDERS';
  resolvedOrders: ResolvedOrder[];
  standoffTerritories: TerritoryId[];
  dislodgedUnits: Unit[];
  destroyedUnits: Unit[];
  ownershipChanges: Array<{
    territory: TerritoryId;
    fromPower: Power | null;
    toPower: Power | null;
  }>;
}

export interface RetreatResolution {
  power: Power;
  unitId: string;
  unitType: UnitType;
  fromTerritory: TerritoryId;
  toTerritory: TerritoryId | null;
  toCoast: Coast | null;
  outcome: 'RETREATED' | 'DISBANDED' | 'CONFLICT';
}

export interface RetreatsPhaseReport extends BasePhaseReport {
  phase: 'RETREATS';
  retreats: RetreatResolution[];
}

export interface AdjustmentResolution {
  power: Power;
  builds: Array<{
    type: UnitType;
    territory: TerritoryId;
    coast: Coast | null;
  }>;
  disbandedUnits: Unit[];
  waivedBuilds: number;
}

export interface BuildsPhaseReport extends BasePhaseReport {
  season: 'WINTER';
  phase: 'BUILDS';
  adjustments: AdjustmentResolution[];
}

export type PublicPhaseReport =
  | OrdersPhaseReport
  | RetreatsPhaseReport
  | BuildsPhaseReport;
