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
  legalOrders?: EngineOrder[] | null;
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

interface EngineOrder {
  type: OrderType;
  unitTerritory: TerritoryId;
  unitCoast?: Coast;
  targetTerritory?: TerritoryId;
  targetCoast?: Coast;
  supportedUnit?: TerritoryId;
  supportedDestination?: TerritoryId;
  viaConvoy?: boolean;
}

export interface GodipAdjudication {
  result: AdjudicationResult;
  units: Unit[];
}

export interface LegalOrderOption {
  id: string;
  unitTerritory: TerritoryId;
  order: Order;
  description: string;
}

const defaultEnginePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../engine/bin/diplomacy-engine'
);

export function adjudicateWithGodip(state: GameState, orders: Order[]): GodipAdjudication {
  const payload = {
    ...engineBoardPayload(state),
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

  const response = executeEngine(payload);

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

export function listLegalOrdersWithGodip(
  state: GameState,
  power: Power
): LegalOrderOption[] {
  const response = executeEngine({
    operation: 'LEGAL_ORDERS',
    power,
    ...engineBoardPayload(state),
    orders: [],
  });
  const byId = new Map<string, LegalOrderOption>();
  for (const engineOrder of response.legalOrders ?? []) {
    const order: Order = {
      id: '',
      power,
      unitTerritory: engineOrder.unitTerritory,
      unitCoast: engineOrder.unitCoast ?? null,
      type: engineOrder.type,
      targetTerritory: engineOrder.targetTerritory ?? null,
      targetCoast: engineOrder.targetCoast ?? null,
      supportedUnit: engineOrder.supportedUnit ?? null,
      supportedDestination: engineOrder.supportedDestination ?? null,
      viaConvoy: engineOrder.viaConvoy || undefined,
    };
    const id = legalOrderId(order);
    order.id = id;
    byId.set(id, {
      id,
      unitTerritory: order.unitTerritory,
      order,
      description: describeLegalOrder(order),
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function legalOrderId(order: Order): string {
  const source = order.unitCoast
    ? `${order.unitTerritory}/${order.unitCoast}`
    : order.unitTerritory;
  if (order.type === 'HOLD') return `${source}|HOLD`;
  if (order.type === 'MOVE') {
    const target = order.targetCoast
      ? `${order.targetTerritory}/${order.targetCoast}`
      : order.targetTerritory;
    return `${source}|${order.viaConvoy ? 'MOVE_VIA_CONVOY' : 'MOVE'}|${target}`;
  }
  if (order.type === 'SUPPORT_HOLD') {
    return `${source}|SUPPORT_HOLD|${order.supportedUnit}`;
  }
  if (order.type === 'SUPPORT_MOVE') {
    return `${source}|SUPPORT_MOVE|${order.supportedUnit}|${order.supportedDestination}`;
  }
  return `${source}|CONVOY|${order.supportedUnit}|${order.targetTerritory}`;
}

function engineBoardPayload(state: GameState) {
  const supplyCenters = Object.fromEntries(
    Object.values(state.territories)
      .filter(territory => territory.isSupplyCenter)
      .map(territory => [territory.id, territory.owner ?? ''])
  );
  return {
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
  };
}

function executeEngine(payload: unknown): EngineResponse {
  const enginePath = process.env.DIPLOMACY_ENGINE_PATH ?? defaultEnginePath;
  const stdout = execFileSync(enginePath, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as EngineResponse;
}

function describeLegalOrder(order: Order): string {
  if (order.type === 'HOLD') return `${order.unitTerritory} holds`;
  if (order.type === 'MOVE') {
    return `${order.unitTerritory} moves to ${order.targetTerritory}${
      order.targetCoast ? `/${order.targetCoast}` : ''
    }${order.viaConvoy ? ' via convoy' : ''}`;
  }
  if (order.type === 'SUPPORT_HOLD') {
    return `${order.unitTerritory} supports ${order.supportedUnit} holding`;
  }
  if (order.type === 'SUPPORT_MOVE') {
    return `${order.unitTerritory} supports ${order.supportedUnit} to ${order.supportedDestination}`;
  }
  return `${order.unitTerritory} convoys ${order.supportedUnit} to ${order.targetTerritory}`;
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
