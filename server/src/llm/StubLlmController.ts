import { randomUUID } from 'crypto';
import type { GameState, Order, Power, SubmitBuildsPayload, TerritoryId } from '@diplomacy/shared';
import type { PowerController } from './PowerController.js';

export class StubLlmController implements PowerController {
  readonly kind = 'LLM' as const;

  constructor(readonly power: Power) {}

  async requestOrders(state: GameState): Promise<Order[]> {
    return state.units
      .filter(unit => unit.power === this.power)
      .map(unit => ({
        id: randomUUID(),
        power: this.power,
        unitTerritory: unit.territory,
        unitCoast: unit.coast,
        type: 'HOLD' as const,
        targetTerritory: null,
        targetCoast: null,
        supportedUnit: null,
        supportedDestination: null,
      }));
  }

  async requestRetreats(state: GameState): Promise<Record<string, TerritoryId | null>> {
    return Object.fromEntries(
      state.units
        .filter(unit => unit.power === this.power && unit.mustRetreat)
        .map(unit => [unit.id, null])
    );
  }

  async requestBuilds(state: GameState): Promise<Omit<SubmitBuildsPayload, 'gameId'>> {
    const ownedCenters = Object.values(state.territories).filter(
      territory => territory.owner === this.power && territory.isSupplyCenter
    ).length;
    const units = state.units.filter(unit => unit.power === this.power);
    const disbandCount = Math.max(0, units.length - ownedCenters);
    return {
      builds: [],
      disbands: units.slice(0, disbandCount).map(unit => unit.id),
    };
  }
}
