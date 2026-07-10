import type { ControllerContext } from './PowerController.js';

export const PROMPT_VERSION = 'diplomacy-controller-v3';

export function buildControllerPrompt(
  context: ControllerContext,
  purpose: 'DIPLOMACY' | 'ORDERS' | 'RETREATS' | 'BUILDS',
  validationErrors: string[] = []
): string {
  const ownUnits = context.state.units.filter(unit => unit.power === context.power);

  return JSON.stringify({
    rulesReference: context.boardContext.rulesReference,
    boardContextVersion: context.boardContext.version,
    purpose,
    power: context.power,
    persona: context.persona,
    phase: {
      year: context.state.year,
      season: context.state.season,
      phase: context.state.phase,
    },
    publicState: {
      boardPosition: context.boardContext.position,
      players: context.state.players.map(player => ({
        name: player.name,
        power: player.power,
        kind: player.kind,
      })),
      lastAdjudicationResult: context.state.lastAdjudicationResult,
    },
    privateState: {
      messages: context.messages,
      strategicSummary: context.memory.strategicSummary,
      agreements: context.memory.agreements,
    },
    actionContext: {
      ownUnits,
      legalOrders: purpose === 'ORDERS'
        ? context.legalOrders.map(option => ({
            id: option.id,
            unitTerritory: option.unitTerritory,
            description: option.description,
          }))
        : [],
      moveSuggestions: purpose === 'ORDERS'
        ? context.moveSuggestions?.map(suggestion => ({
            id: suggestion.id,
            score: suggestion.score,
            rationale: suggestion.rationale,
            orderIds: suggestion.orderIds,
          })) ?? []
        : [],
    },
    validationErrors,
  });
}

export const CONTROLLER_SYSTEM_PROMPT = [
  'You control one power in a standard game of Diplomacy.',
  'Choose actions that advance that power while considering all private negotiations and agreements.',
  'Treat agreements as strategic commitments, not mechanically enforced rules.',
  'Return only the requested schema. Do not include hidden reasoning or chain-of-thought.',
  'The strategicSummary must be concise and suitable for private memory in a later turn.',
  'In diplomatic replies and strategic summaries, always use full spoken territory names such as Rumania and Bulgaria, never abbreviations such as RUM or BUL.',
  'Structured game actions must still use the exact territory identifiers from the supplied state.',
  'For order decisions, choose either one supplied moveSuggestion ID or exactly one supplied legal order ID per active unit.',
  'Never invent an order or territory relationship that is not present in the supplied board context.',
].join(' ');
