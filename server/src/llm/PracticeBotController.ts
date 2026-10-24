import { randomUUID } from 'crypto';
import type { Order, RetreatDestination, SubmitBuildsPayload } from '@diplomacy/shared';
import { botDecision } from '../attempts/PracticeBot.js';
import { exportBoard } from '../fixtures/BoardFixture.js';
import type { ControllerContext, ControllerDecision } from './PowerController.js';
import { StubLlmController } from './StubLlmController.js';

/** The seat model that plays a hosted room's power with the free practice bot. */
export const PRACTICE_BOT_MODEL = 'practice-bot-v1';
/** Seat models that make no provider call: they need no AI authorization and cost nothing. */
export const OFFLINE_SEAT_MODELS: readonly string[] = ['idle', 'auto-hold-v0', PRACTICE_BOT_MODEL];
export const isOfflineSeatModel = (model: string | undefined): boolean => !model?.trim() || OFFLINE_SEAT_MODELS.includes(model.trim().toLowerCase());

/**
 * A hosted room's power played by the challenge's practice bot: it seeks supply centers, supports its own
 * attacks and defends threatened home centers, from the room's own legal orders. It sends no messages
 * (the stub's diplomacy) and makes no provider call. Seeded from the game and phase, so a decision made
 * again for the same position is the same.
 */
export class PracticeBotController extends StubLlmController {
  private decide(context: ControllerContext) {
    const { state } = context;
    return botDecision(exportBoard(state), this.power, context.legalOrders, state.gameId, `${state.year}-${state.season}-${state.phase}`);
  }

  override async requestOrders(context: ControllerContext): Promise<ControllerDecision<Order[]>> {
    const action = this.decide(context);
    const chosen = action.phase === 'ORDERS' ? action.orderIds : [];
    return {
      actions: chosen.map(id => context.legalOrders.find(option => option.id === id)!.order).map(order => ({ ...order, id: randomUUID() })),
      strategicSummary: 'Practice bot: seek supply centers and support its own attacks.',
      agreements: context.memory.agreements,
    };
  }

  override async requestRetreats(context: ControllerContext): Promise<ControllerDecision<Record<string, RetreatDestination | null>>> {
    const action = this.decide(context);
    return { actions: action.phase === 'RETREATS' ? action.retreats : {}, strategicSummary: 'Practice bot: retreat toward a center.', agreements: context.memory.agreements };
  }

  override async requestBuilds(context: ControllerContext): Promise<ControllerDecision<Omit<SubmitBuildsPayload, 'gameId'>>> {
    const action = this.decide(context);
    return {
      actions: action.phase === 'BUILDS' ? { builds: action.builds, disbands: action.disbands } : { builds: [], disbands: [] },
      strategicSummary: 'Practice bot: build toward a two-to-one balance of armies to fleets.', agreements: context.memory.agreements,
    };
  }
}
