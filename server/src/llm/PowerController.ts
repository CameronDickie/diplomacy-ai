import type { GameState, Order, Power, SubmitBuildsPayload, TerritoryId } from '@diplomacy/shared';

export interface PowerController {
  readonly power: Power;
  readonly kind: 'HUMAN' | 'LLM';
  requestOrders(state: GameState): Promise<Order[]>;
  requestRetreats(state: GameState): Promise<Record<string, TerritoryId | null>>;
  requestBuilds(state: GameState): Promise<Omit<SubmitBuildsPayload, 'gameId'>>;
}

export interface LlmProvider {
  readonly id: string;
  completeJson<T>(request: {
    model: string;
    system: string;
    prompt: string;
    schemaName: string;
  }): Promise<T>;
}
