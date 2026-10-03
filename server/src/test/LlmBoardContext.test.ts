import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  LlmDiplomacyMemory,
  Power,
} from '@diplomacy/shared';
import { GameRoom } from '../GameRoom.js';
import {
  listLegalOrdersWithGodip,
  type LegalOrderOption,
} from '../adjudication/GodipAdjudicator.js';
import {
  BOARD_CONTEXT_VERSION,
  buildLlmBoardContext,
} from '../llm/BoardContext.js';
import type {
  ControllerContext,
  LlmProvider,
  LlmProviderResult,
} from '../llm/PowerController.js';
import { buildControllerPrompt } from '../llm/PromptBuilder.js';
import { StructuredLlmController } from '../llm/StructuredLlmController.js';
import { suggestMoveOrderSets } from '../llm/MoveSuggestionEngine.js';

test('board context distinguishes topology, ownership, occupancy, and build sites', () => {
  const state = new GameRoom().getState();
  state.season = 'FALL';
  state.territories.GRE.owner = 'AUSTRIA';
  state.units = state.units
    .filter(unit => unit.territory !== 'VIE')
    .concat({
      id: 'italy-in-greece',
      power: 'ITALY',
      type: 'ARMY',
      territory: 'GRE',
      coast: null,
      mustRetreat: false,
      retreatOptions: [],
      retreatCoasts: {},
      dislodgedBy: null,
    });

  const context = buildLlmBoardContext(state);
  assert.equal(context.version, BOARD_CONTEXT_VERSION);
  const adriatic = context.rulesReference.find(territory => territory.id === 'ADR');
  const ionian = context.rulesReference.find(territory => territory.id === 'ION');
  assert.ok(Array.isArray(adriatic?.fleetAdjacent));
  assert.equal((adriatic?.fleetAdjacent as string[]).includes('GRE'), false);
  assert.equal((ionian?.fleetAdjacent as string[]).includes('GRE'), true);

  const greece = context.position.supplyCenters.find(center => center.territory === 'GRE');
  assert.deepEqual(greece, {
    territory: 'GRE',
    owner: 'AUSTRIA',
    homePower: null,
    occupiedBy: 'ITALY',
  });
  assert.deepEqual(context.position.pendingFallCaptures, [{
    territory: 'GRE',
    currentOwner: 'AUSTRIA',
    occupyingPower: 'ITALY',
  }]);

  const austria = context.position.adjustmentByPower.find(item => item.power === 'AUSTRIA');
  assert.ok(austria?.legalBuildSites.some(site => site.territory === 'VIE'));
  assert.equal(austria?.legalBuildSites.some(site => site.territory === 'GRE'), false);

  const prompt = JSON.parse(
    buildControllerPrompt(controllerContext(state, 'ITALY', []), 'DIPLOMACY')
  ) as {
    boardContextVersion: string;
    publicState: { boardPosition: typeof context.position };
    actionContext: { legalOrders: unknown[] };
  };
  assert.equal(prompt.boardContextVersion, BOARD_CONTEXT_VERSION);
  assert.equal(
    prompt.publicState.boardPosition.supplyCenters
      .find(center => center.territory === 'GRE')?.owner,
    'AUSTRIA'
  );
  assert.deepEqual(prompt.actionContext.legalOrders, []);
});

test('Godip legal-order catalog is stable and tactical suggestions only use catalog IDs', async () => {
  const state = new GameRoom().getState();
  const first = await listLegalOrdersWithGodip(state, 'ENGLAND');
  const second = await listLegalOrdersWithGodip(state, 'ENGLAND');
  assert.deepEqual(first.map(option => option.id), second.map(option => option.id));
  assert.ok(first.some(option => option.id === 'LON|MOVE|WAL'));
  assert.ok(first.some(option => option.id === 'LON|MOVE|YOR'));

  const legalIds = new Set(first.map(option => option.id));
  const suggestions = suggestMoveOrderSets(state, 'ENGLAND', first);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every(suggestion =>
    suggestion.orderIds.every(orderId => legalIds.has(orderId))
  ));
});

test('structured order decisions require one supplied legal order per active unit', async () => {
  const state = new GameRoom().getState();
  const legalOrders = await listLegalOrdersWithGodip(state, 'ENGLAND');
  const context = controllerContext(state, 'ENGLAND', legalOrders);
  const holdIds = legalOrders
    .filter(option => option.order.type === 'HOLD')
    .map(option => option.id);

  const valid = new StructuredLlmController(
    'ENGLAND',
    'test-model',
    providerReturning({
      strategicSummary: 'Hold the opening position.',
      agreements: [],
      selectedSuggestionId: null,
      selectedOrderIds: holdIds,
    })
  );
  const decision = await valid.requestOrders(context);
  assert.equal(decision.actions.length, 3);
  assert.ok(decision.actions.every(order => order.type === 'HOLD'));

  const invalid = new StructuredLlmController(
    'ENGLAND',
    'test-model',
    providerReturning({
      strategicSummary: 'Invalid duplicate selection.',
      agreements: [],
      selectedSuggestionId: null,
      selectedOrderIds: [holdIds[0], holdIds[0], holdIds[0]],
    })
  );
  await assert.rejects(
    () => invalid.requestOrders(context),
    /Exactly one legal order is required/
  );
});

function controllerContext(
  state: ReturnType<GameRoom['getState']>,
  power: Power,
  legalOrders: LegalOrderOption[]
): ControllerContext {
  const memory: LlmDiplomacyMemory = {
    power,
    revision: 0,
    updatedAt: null,
    messageIdsByPower: {},
    diplomaticContext: '',
    strategicSummary: '',
    agreements: [],
  };
  return {
    state,
    power,
    persona: null,
    messages: [],
    memory,
    boardContext: buildLlmBoardContext(state),
    legalOrders,
    moveSuggestions: suggestMoveOrderSets(state, power, legalOrders),
  };
}

function providerReturning(value: unknown): LlmProvider {
  return {
    id: 'TEST',
    async completeJson<T>(): Promise<LlmProviderResult<T>> {
      return {
        value: value as T,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}
