import type { GameState, Power, TerritoryId } from '@diplomacy/shared';
import type { LegalOrderOption } from '../adjudication/GodipAdjudicator.js';

export interface MoveSuggestion {
  id: string;
  score: number;
  rationale: string;
  orderIds: string[];
}

export function suggestMoveOrderSets(
  state: GameState,
  power: Power,
  legalOrders: LegalOrderOption[],
  maxSuggestions = 8
): MoveSuggestion[] {
  const activeUnits = state.units.filter(unit => unit.power === power && !unit.mustRetreat);
  if (activeUnits.length === 0) return [];

  const holds = new Map(
    legalOrders
      .filter(option => option.order.type === 'HOLD')
      .map(option => [option.unitTerritory, option.id])
  );
  if (activeUnits.some(unit => !holds.has(unit.territory))) return [];

  const baseline = activeUnits
    .map(unit => holds.get(unit.territory)!)
    .sort();
  const suggestions: MoveSuggestion[] = [{
    id: suggestionId(state, power, 'hold-all'),
    score: 0,
    rationale: 'Hold every active unit.',
    orderIds: baseline,
  }];

  for (const option of legalOrders) {
    const order = option.order;
    if (order.type === 'MOVE' && !order.viaConvoy && order.targetTerritory) {
      suggestions.push({
        id: suggestionId(state, power, option.id),
        score: scoreDestination(state, power, order.targetTerritory),
        rationale: option.description,
        orderIds: replaceOrders(baseline, legalOrders, [option]),
      });
    }
    if (order.type === 'SUPPORT_HOLD' && order.supportedUnit) {
      suggestions.push({
        id: suggestionId(state, power, option.id),
        score: 1 + scoreDestination(state, power, order.supportedUnit) / 2,
        rationale: option.description,
        orderIds: replaceOrders(baseline, legalOrders, [option]),
      });
    }
    if (order.type === 'SUPPORT_MOVE' && order.supportedUnit && order.supportedDestination) {
      const supportedMove = legalOrders.find(candidate =>
        candidate.unitTerritory === order.supportedUnit &&
        candidate.order.type === 'MOVE' &&
        candidate.order.targetTerritory === order.supportedDestination &&
        !candidate.order.viaConvoy
      );
      if (supportedMove) {
        suggestions.push({
          id: suggestionId(state, power, option.id),
          score: 2 + scoreDestination(state, power, order.supportedDestination),
          rationale: `${option.description}; ${supportedMove.description}.`,
          orderIds: replaceOrders(baseline, legalOrders, [option, supportedMove]),
        });
      }
    }
  }

  for (const armyMove of legalOrders.filter(option =>
    option.order.type === 'MOVE' && option.order.viaConvoy
  )) {
    const destination = armyMove.order.targetTerritory;
    if (!destination) continue;
    const convoyOrders = legalOrders.filter(option =>
      option.order.type === 'CONVOY' &&
      option.order.supportedUnit === armyMove.unitTerritory &&
      option.order.targetTerritory === destination
    );
    if (convoyOrders.length === 0) continue;
    suggestions.push({
      id: suggestionId(state, power, armyMove.id),
      score: 1 + scoreDestination(state, power, destination),
      rationale: `${armyMove.description} using available convoying fleets.`,
      orderIds: replaceOrders(baseline, legalOrders, [armyMove, ...convoyOrders]),
    });
  }

  return deduplicateSuggestions(suggestions)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, maxSuggestions);
}

function replaceOrders(
  baseline: string[],
  catalog: LegalOrderOption[],
  replacements: LegalOrderOption[]
): string[] {
  const replacementSources = new Set(replacements.map(option => option.unitTerritory));
  return [
    ...baseline.filter(id => {
      const source = catalog.find(option => option.id === id)?.unitTerritory;
      return source && !replacementSources.has(source);
    }),
    ...replacements.map(option => option.id),
  ].sort();
}

function deduplicateSuggestions(suggestions: MoveSuggestion[]): MoveSuggestion[] {
  const seen = new Set<string>();
  return suggestions.filter(suggestion => {
    const key = suggestion.orderIds.join('\n');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreDestination(
  state: GameState,
  power: Power,
  destination: TerritoryId
): number {
  const territory = state.territories[destination];
  if (!territory?.isSupplyCenter) return 1;
  if (territory.owner === power) return 2;
  if (!territory.owner) return 5;
  return 6;
}

function suggestionId(
  state: GameState,
  power: Power,
  suffix: string
): string {
  return [
    'advisor',
    state.year,
    state.season.toLowerCase(),
    power.toLowerCase(),
    suffix.toLowerCase().replaceAll('|', '-').replaceAll('/', '-'),
  ].join('-');
}
