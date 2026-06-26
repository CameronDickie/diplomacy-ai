import type { ControllerContext } from './PowerController.js';
import {
  getArmyAdjacency,
  getFleetAdjacency,
  TERRITORIES,
} from '@diplomacy/shared';

export const PROMPT_VERSION = 'diplomacy-controller-v2';

export function buildControllerPrompt(
  context: ControllerContext,
  purpose: 'DIPLOMACY' | 'ORDERS' | 'RETREATS' | 'BUILDS',
  validationErrors: string[] = []
): string {
  const ownUnits = context.state.units.filter(unit => unit.power === context.power);
  const movementOptions = Object.fromEntries(
    ownUnits
      .filter(unit => !unit.mustRetreat)
      .map(unit => [
        unit.territory,
        unit.type === 'ARMY'
          ? getArmyAdjacency(unit.territory)
          : getFleetAdjacency(unit.territory, unit.coast),
      ])
  );

  return JSON.stringify({
    purpose,
    power: context.power,
    persona: context.persona,
    phase: {
      year: context.state.year,
      season: context.state.season,
      phase: context.state.phase,
    },
    publicState: {
      units: context.state.units,
      territories: context.state.territories,
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
      movementOptions,
      moveSuggestions: context.moveSuggestions?.map(suggestion => ({
        id: suggestion.id,
        score: suggestion.score,
        rationale: suggestion.rationale,
        orders: suggestion.orders,
      })) ?? [],
      territoryNames: Object.fromEntries(
        TERRITORIES.map(territory => [territory.id, territory.name])
      ),
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
  'For order decisions, prefer a supplied moveSuggestion by returning its selectedSuggestionId when it matches your strategic intent; otherwise set selectedSuggestionId to null and provide explicit actions.',
].join(' ');
