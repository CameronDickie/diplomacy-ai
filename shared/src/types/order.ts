import type { Power } from './game.js';
import type { TerritoryId, Coast } from './territory.js';
import type { Unit } from './unit.js';

export type OrderType = 'HOLD' | 'MOVE' | 'SUPPORT_HOLD' | 'SUPPORT_MOVE' | 'CONVOY';

export interface Order {
  id: string;
  power: Power;
  unitTerritory: TerritoryId;
  unitCoast: Coast | null;
  type: OrderType;
  /** MOVE or CONVOY: destination territory */
  targetTerritory: TerritoryId | null;
  /** MOVE: coast specifier for fleet entering multi-coast territory */
  targetCoast: Coast | null;
  /** MOVE: force an adjacent army move to use a convoy route */
  viaConvoy?: boolean;
  /** SUPPORT_HOLD / SUPPORT_MOVE: territory of the unit being supported */
  supportedUnit: TerritoryId | null;
  /** SUPPORT_MOVE: destination the supported unit is moving to */
  supportedDestination: TerritoryId | null;
}

export type OrderResolution =
  | 'SUCCEEDS'
  | 'FAILS'
  | 'BOUNCED'
  | 'DISLODGED'
  | 'CUT'
  | 'VOID';

export interface ResolvedOrder extends Order {
  resolution: OrderResolution;
  reason: string;
}

export interface AdjudicationResult {
  resolvedOrders: ResolvedOrder[];
  dislodgedUnits: Unit[];
  destroyedUnits: Unit[];
  /** Only populated after Fall adjudication */
  newTerritoryOwnership: Record<TerritoryId, Power | null>;
  /** Positive = may build, negative = must disband */
  buildCounts: Record<Power, number>;
  /** Territories where a standoff occurred (units bounced here) */
  standoffTerritories: TerritoryId[];
  /** Full Godip retreat constraints; destinations alone lose bounce exceptions. */
  retreatContext?: {
    dislodgers: Record<TerritoryId, TerritoryId>;
    bounces: Record<TerritoryId, TerritoryId[]>;
  };
}
