import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type {
  AdjudicationResult,
  Coast,
  GameState,
  Order,
  OrderResolution,
  OrderType,
  Power,
  ResolvedOrder,
  TerritoryId,
  Unit,
  UnitType,
} from '@diplomacy/shared';

interface EngineResponse {
  units: EngineUnit[] | null;
  dislodged: EngineUnit[] | null;
  resolutions: EngineResolution[] | null;
  standoffs: TerritoryId[] | null;
}

interface EngineUnit {
  id: string;
  type: UnitType;
  power: Power;
  territory: TerritoryId;
  coast?: Coast;
  dislodgedBy?: TerritoryId;
  retreatOptions?: EngineRetreatOption[];
}

interface EngineRetreatOption {
  territory: TerritoryId;
  coast?: Coast;
}

interface EngineResolution {
  source: TerritoryId;
  type: OrderType;
  targets: TerritoryId[];
  error?: string;
}

export interface GodipAdjudication {
  result: AdjudicationResult;
  units: Unit[];
}

const defaultEnginePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../engine/bin/diplomacy-engine'
);

export function adjudicateWithGodip(state: GameState, orders: Order[]): GodipAdjudication {
  const supplyCenters = Object.fromEntries(
    Object.values(state.territories)
      .filter(territory => territory.isSupplyCenter)
      .map(territory => [territory.id, territory.owner ?? ''])
  );
  const payload = {
    year: state.year,
    season: state.season,
    units: state.units
      .filter(unit => !unit.mustRetreat)
      .map(unit => ({
        id: unit.id,
        type: unit.type,
        power: unit.power,
        territory: unit.territory,
        coast: unit.coast ?? undefined,
      })),
    supplyCenters,
    orders: orders.map(order => ({
      type: order.type,
      unitTerritory: order.unitTerritory,
      unitCoast: order.unitCoast ?? undefined,
      targetTerritory: order.targetTerritory ?? undefined,
      targetCoast: order.targetCoast ?? undefined,
      supportedUnit: order.supportedUnit ?? undefined,
      supportedDestination: order.supportedDestination ?? undefined,
      viaConvoy: order.viaConvoy,
    })),
  };

  const enginePath = process.env.DIPLOMACY_ENGINE_PATH ?? defaultEnginePath;
  const stdout = execFileSync(enginePath, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const response = JSON.parse(stdout) as EngineResponse;

  const dislodged = response.dislodged ?? [];
  const activeUnits = (response.units ?? []).map(unit => toUnit(unit));
  const retreatingUnits = dislodged
    .filter(unit => (unit.retreatOptions?.length ?? 0) > 0)
    .map(unit => toUnit(unit, true));
  const destroyedUnits = dislodged
    .filter(unit => (unit.retreatOptions?.length ?? 0) === 0)
    .map(unit => toUnit(unit, true));
  const resolvedOrders = (response.resolutions ?? []).map(resolution =>
    toResolvedOrder(resolution, state, orders)
  );

  return {
    units: [...activeUnits, ...retreatingUnits],
    result: {
      resolvedOrders,
      dislodgedUnits: retreatingUnits,
      destroyedUnits,
      newTerritoryOwnership: {},
      buildCounts: {} as Record<Power, number>,
      standoffTerritories: response.standoffs ?? [],
    },
  };
}

function toUnit(unit: EngineUnit, mustRetreat = false): Unit {
  return {
    id: unit.id,
    type: unit.type,
    power: unit.power,
    territory: unit.territory,
    coast: unit.coast ?? null,
    mustRetreat,
    retreatOptions: [...new Set(unit.retreatOptions?.map(option => option.territory) ?? [])],
    retreatCoasts: Object.fromEntries(
      [...new Set(unit.retreatOptions?.map(option => option.territory) ?? [])]
        .map(territory => [
          territory,
          unit.retreatOptions
            ?.filter(option => option.territory === territory && option.coast)
            .map(option => option.coast!)
            ?? [],
        ])
        .filter(([, coasts]) => coasts.length > 0)
    ),
    dislodgedBy: unit.dislodgedBy ?? null,
  };
}

function toResolvedOrder(
  resolution: EngineResolution,
  state: GameState,
  submittedOrders: Order[]
): ResolvedOrder {
  const submitted = submittedOrders.find(order => order.unitTerritory === resolution.source);
  const unit = state.units.find(candidate => candidate.territory === resolution.source);
  const type = resolution.type;
  const base: Order = submitted ?? {
    id: `engine-${state.year}-${state.season}-${resolution.source}`,
    power: unit?.power ?? 'AUSTRIA',
    unitTerritory: resolution.source,
    unitCoast: unit?.coast ?? null,
    type,
    targetTerritory: type === 'MOVE' || type === 'CONVOY' ? resolution.targets.at(-1) ?? null : null,
    targetCoast: null,
    supportedUnit: type.startsWith('SUPPORT') || type === 'CONVOY' ? resolution.targets[1] ?? null : null,
    supportedDestination: type === 'SUPPORT_MOVE' ? resolution.targets[2] ?? null : null,
  };
  return {
    ...base,
    type,
    resolution: classifyResolution(resolution.error),
    reason: resolution.error ?? 'Order succeeded',
  };
}

function classifyResolution(error?: string): OrderResolution {
  if (!error) return 'SUCCEEDS';
  if (error.includes('Bounce')) return 'BOUNCED';
  if (error.includes('SupportBroken')) return 'CUT';
  if (error.includes('Invalid') || error.includes('Illegal') || error.includes('Missing')) {
    return 'VOID';
  }
  return 'FAILS';
}
