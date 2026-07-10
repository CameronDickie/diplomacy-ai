import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ConversationPresencePayload,
  Order,
  Power,
  TerritoryId,
  Unit,
} from '@diplomacy/shared';
import type { PowerController } from '../llm/PowerController.js';
import { CONTROLLER_SYSTEM_PROMPT } from '../llm/PromptBuilder.js';
import { buildLlmRuntimePolicy } from '../llm/policy.js';
import { GameRoom } from '../GameRoom.js';

test('human sessions resume without exposing socket IDs', () => {
  const room = new GameRoom();
  const joined = room.addPlayer('socket-one', 'Host');
  assert.ok(joined);
  assert.equal(room.isHost('socket-one'), true);
  assert.equal('socketId' in room.getState().players[0], false);

  room.markDisconnected('socket-one');
  assert.equal(joined.player.connected, false);

  const resumed = room.resumePlayer('socket-two', joined.sessionToken);
  assert.equal(resumed?.id, joined.player.id);
  assert.equal(resumed?.connected, true);
  assert.equal(room.getPlayerBySocket('socket-two')?.id, joined.player.id);
  assert.equal(room.resumePlayer('attacker', 'invalid-token'), undefined);
});

test('players cannot join after a game starts', async () => {
  const room = new GameRoom();
  for (let index = 0; index < 7; index++) {
    assert.ok(room.addPlayer(`socket-${index}`, `Player ${index}`));
  }
  assert.equal(await room.startGame(), true);
  assert.equal(room.addPlayer('late-socket', 'Late Player'), null);
});

test('a human can advance an opening turn with six automated players', async () => {
  const room = new GameRoom();
  const human = room.addPlayer('human-socket', 'Human', 'AUSTRIA');
  assert.ok(human);

  for (let index = 0; index < 6; index++) {
    assert.ok(room.addLlmPlayer());
  }

  assert.equal(await room.startGame(), true);
  await room.submitOrders(human.player.power, []);

  const state = room.getState();
  assert.equal(state.year, 1901);
  assert.equal(state.season, 'FALL');
  assert.equal(state.phase, 'ORDERS');
  assert.equal(state.status, 'IN_PROGRESS');
});

test('orders cannot be issued for another power', () => {
  const room = new GameRoom();
  const austria = room.addPlayer('austria-socket', 'Austria', 'AUSTRIA');
  assert.ok(austria);

  const enemyOrder: Order = {
    id: 'enemy-order',
    power: austria.player.power,
    unitTerritory: 'LON',
    unitCoast: null,
    type: 'HOLD',
    targetTerritory: null,
    targetCoast: null,
    supportedUnit: null,
    supportedDestination: null,
  };
  assert.match(room.validateOrders(austria.player.power, [enemyOrder]) ?? '', /Cannot issue/);
});

test('build validation rejects foreign disbands and unavailable builds', () => {
  const room = new GameRoom();
  const austria = room.addPlayer('austria-socket', 'Austria', 'AUSTRIA');
  assert.ok(austria);
  const englishUnit = room.getState().units.find(unit => unit.power === 'ENGLAND');
  assert.ok(englishUnit);

  assert.match(
    room.validateBuilds(austria.player.power, {
      gameId: room.gameId,
      builds: [],
      disbands: [englishUnit.id],
    }) ?? '',
    /cannot be disbanded|do not control/i
  );
  assert.match(
    room.validateBuilds(austria.player.power, {
      gameId: room.gameId,
      builds: [{ type: 'ARMY', territory: 'VIE', coast: null }],
      disbands: [],
    }) ?? '',
    /No builds are available/
  );
});

test('diplomacy stays private while LLM memory spans all of its conversations', async () => {
  const room = new GameRoom();
  assert.ok(room.addPlayer('austria-socket', 'Austria', 'AUSTRIA'));
  assert.ok(room.addPlayer('england-socket', 'England', 'ENGLAND'));
  assert.ok(room.addPlayer('france-socket', 'France', 'FRANCE'));
  const germany = room.addLlmPlayer();
  assert.ok(germany);
  assert.equal(germany.power, 'GERMANY');

  const frenchExchange = await room.sendDiplomaticMessage(
    'FRANCE',
    'GERMANY',
    'I propose a non-aggression pact over Burgundy.',
    '00000000-0000-4000-8000-000000000001'
  );
  const englishExchange = await room.sendDiplomaticMessage(
    'GERMANY',
    'ENGLAND',
    'France proposed a non-aggression pact over Burgundy.'
  );

  assert.equal(frenchExchange.length, 2);
  assert.equal(frenchExchange[0].id, '00000000-0000-4000-8000-000000000001');
  assert.equal(englishExchange.length, 1);
  assert.equal(room.getDiplomaticMessages('AUSTRIA').length, 0);
  assert.equal(room.getDiplomaticMessages('FRANCE').length, 2);
  assert.equal(room.getDiplomaticMessages('ENGLAND').length, 1);
  assert.equal(room.getDiplomaticMessages('GERMANY').length, 3);

  const memory = room.getLlmDiplomacyMemory('GERMANY');
  assert.ok(memory);
  assert.equal(memory.revision, 4);
  assert.match(memory.diplomaticContext, /FRANCE -> GERMANY: I propose a non-aggression pact/);
  assert.match(memory.diplomaticContext, /GERMANY -> ENGLAND: France proposed/);
  assert.equal(memory.messageIdsByPower.FRANCE?.length, 2);
  assert.equal(memory.messageIdsByPower.ENGLAND?.length, 1);
});

test('controller prompt requires spoken territory names in conversational output', () => {
  assert.match(CONTROLLER_SYSTEM_PROMPT, /full spoken territory names/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /Rumania and Bulgaria/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /Structured game actions.*exact territory identifiers/);
  const room = new GameRoom();
  assert.ok(room.addLlmPlayer({ power: 'GERMANY' }));
  assert.match(
    room.buildVoiceSessionInstructions('GERMANY', 'ENGLAND'),
    /Think silently before responding/
  );
});

test('players may choose an available power or request random assignment', () => {
  const room = new GameRoom();
  const france = room.addPlayer('france-socket', 'France', 'FRANCE');
  assert.equal(france?.player.power, 'FRANCE');
  assert.equal(room.addPlayer('stale-socket', 'Stale France', 'FRANCE'), null);

  const random = room.addPlayer('random-socket', 'Random', 'RANDOM');
  assert.ok(random);
  assert.notEqual(random.player.power, 'FRANCE');
});

test('host-configurable LLM negotiation count is validated and stored', () => {
  const room = new GameRoom();
  assert.equal(room.getState().settings.llmNegotiationInitiators, 2);
  assert.equal(room.updateGameSettings({
    llmNegotiationInitiators: 5,
    llmNegotiationMaxMessages: 8,
    llmNegotiationWarningAtMessages: 6,
    llmNegotiationPlannerModel: 'gpt-5.4-mini',
    voiceAutoCommitSilenceSeconds: 3.5,
  }), true);
  assert.equal(room.getState().settings.llmNegotiationInitiators, 5);
  assert.equal(room.getState().settings.llmNegotiationMaxMessages, 8);
  assert.equal(room.getState().settings.llmNegotiationWarningAtMessages, 6);
  assert.equal(room.getState().settings.llmNegotiationPlannerModel, 'gpt-5.4-mini');
  assert.equal(room.getState().settings.voiceAutoCommitSilenceSeconds, 3.5);
  assert.equal(room.updateLlmNegotiationInitiators(-1), false);
  assert.equal(room.updateLlmNegotiationInitiators(8), false);
  assert.equal(room.updateLlmNegotiationInitiators(1.5), false);
  assert.equal(room.updateGameSettings({
    llmNegotiationMaxMessages: 3,
    llmNegotiationWarningAtMessages: 4,
  }), false);
  assert.equal(room.updateGameSettings({ voiceAutoCommitSilenceSeconds: Number.NaN }), false);
  assert.equal(room.getState().settings.llmNegotiationInitiators, 5);
});

test('structured LLM memory carries agreements across private conversations', async () => {
  let englandContextSawAgreement = false;
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context) {
        return {
          toPower: null,
          message: '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context, incomingMessage) {
        if (incomingMessage.fromPower === 'ENGLAND') {
          englandContextSawAgreement = context.memory.agreements.some(
            agreement => agreement.summary === 'Keep Burgundy demilitarized'
          );
        }
        return {
          reply: 'Acknowledged.',
          strategicSummary: 'Maintain the French pact while discussing England.',
          agreements: incomingMessage.fromPower === 'FRANCE'
            ? [{
                id: 'burgundy-pact',
                parties: ['FRANCE', 'GERMANY'],
                summary: 'Keep Burgundy demilitarized',
                status: 'ACTIVE',
                sourceMessageIds: [incomingMessage.id],
                createdYear: context.state.year,
                createdSeason: context.state.season,
                expiresYear: null,
                expiresSeason: null,
              }]
            : context.memory.agreements,
        };
      },
      async requestOrders() {
        return { actions: [], strategicSummary: '', agreements: [] };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });
  assert.ok(room.addPlayer('france-socket', 'France', 'FRANCE'));
  assert.ok(room.addPlayer('england-socket', 'England', 'ENGLAND'));
  assert.ok(room.addLlmPlayer({ power: 'GERMANY' }));

  await room.sendDiplomaticMessage(
    'FRANCE',
    'GERMANY',
    'Let us keep Burgundy demilitarized.'
  );
  await room.sendDiplomaticMessage(
    'ENGLAND',
    'GERMANY',
    'What have you agreed with France?'
  );

  assert.equal(englandContextSawAgreement, true);
});

test('invalid automated orders retry and fall back without blocking the phase', async () => {
  const attempts = new Map<Power, number>();
  const room = new GameRoom({
    controllerFactory: ({ power }) => invalidOrderController(power, attempts),
  });
  const human = room.addPlayer('human-socket', 'Human', 'AUSTRIA');
  assert.ok(human);
  for (let index = 0; index < 6; index++) assert.ok(room.addLlmPlayer());

  assert.equal(await room.startGame(), true);
  await room.submitOrders('AUSTRIA', []);

  assert.equal(room.getState().season, 'FALL');
  assert.equal(room.getState().phase, 'ORDERS');
  assert.equal(room.getLlmRunArtifacts().length, 6);
  assert.ok(room.getLlmRunArtifacts().every(artifact => artifact.fallbackReason));
  assert.ok([...attempts.values()].every(count => count === 2));
});

test('configured LLMs initiate bounded negotiations before automated orders', async () => {
  const initiatives: Power[] = [];
  const replies: Power[] = [];
  const orderMessageCounts = new Map<Power, number>();
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context, eligiblePowers) {
        initiatives.push(power);
        const target = eligiblePowers.find(candidate =>
          context.state.players.some(player =>
            player.power === candidate && player.kind === 'LLM'
          )
        ) ?? null;
        return {
          toPower: target,
          message: target
            ? `I want to coordinate with ${target}.`
            : '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        replies.push(power);
        return {
          reply: 'I am open to coordinating this phase.',
          strategicSummary: 'Consider the new coordination proposal.',
          agreements: context.memory.agreements,
        };
      },
      async requestOrders(context) {
        orderMessageCounts.set(power, context.messages.length);
        return {
          actions: context.state.units
            .filter(unit => unit.power === power && !unit.mustRetreat)
            .map(unit => ({
              id: `${power}-${unit.id}`,
              power,
              unitTerritory: unit.territory,
              unitCoast: unit.coast,
              type: 'HOLD' as const,
              targetTerritory: null,
              targetCoast: null,
              supportedUnit: null,
              supportedDestination: null,
            })),
          strategicSummary: 'Orders account for the completed negotiation round.',
          agreements: context.memory.agreements,
        };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });

  assert.ok(room.addPlayer('human-socket', 'Human', 'AUSTRIA'));
  for (const power of ['ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'] as Power[]) {
    assert.ok(room.addLlmPlayer({ power, provider: 'OPENAI', model: 'test-model' }));
  }
  assert.equal(room.updateLlmNegotiationInitiators(4), true);

  assert.equal(await room.startGame(), true);
  await room.submitOrders('AUSTRIA', []);

  assert.ok(initiatives.length >= 4);
  assert.ok(replies.length >= 4);
  const springDiplomacyArtifacts = room.getLlmRunArtifacts().filter(
    artifact =>
      artifact.purpose === 'DIPLOMACY' &&
      artifact.year === 1901 &&
      artifact.season === 'SPRING'
  );
  assert.equal(springDiplomacyArtifacts.length, 8);
  assert.ok(
    springDiplomacyArtifacts
      .every(artifact =>
        artifact.strategicSummary !== null &&
        artifact.structuredDecision !== null &&
        Array.isArray(artifact.contextMessageIds) &&
        artifact.boardSnapshot.units.length > 0 &&
        artifact.statusHistory[0]?.status === 'QUEUED' &&
        artifact.statusHistory.at(-1)?.status === 'COMPLETE'
      )
  );
  const artifacts = room.getLlmRunArtifacts();
  artifacts[0].boardSnapshot.units.length = 0;
  assert.ok(room.getLlmRunArtifacts()[0].boardSnapshot.units.length > 0);
  assert.ok([...orderMessageCounts.values()].some(count => count > 0));
  assert.equal(room.getState().season, 'FALL');
});

test('autonomous conversations continue by consent and stop at the hard cap', async () => {
  const modelsByPurpose: string[] = [];
  const replyMessageNumbers: number[] = [];
  const room = new GameRoom({
    controllerFactory: ({ power, model }) => ({
      power,
      async requestDiplomaticInitiative(context, eligiblePowers) {
        modelsByPurpose.push(model);
        const target = eligiblePowers.find(candidate =>
          context.state.players.some(player =>
            player.power === candidate && player.kind === 'LLM'
          )
        ) ?? null;
        return {
          toPower: target,
          message: target ? 'Please coordinate this phase with me.' : '',
          expectsReply: true,
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context, _incoming, conversation) {
        replyMessageNumbers.push(conversation?.messageNumber ?? 0);
        return {
          reply: 'I need one more response before finalizing.',
          expectsReply: true,
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestOrders(context) {
        modelsByPurpose.push(model);
        return {
          actions: context.state.units
            .filter(unit => unit.power === power && !unit.mustRetreat)
            .map(unit => ({
              id: `${power}-${unit.id}`,
              power,
              unitTerritory: unit.territory,
              unitCoast: unit.coast,
              type: 'HOLD' as const,
              targetTerritory: null,
              targetCoast: null,
              supportedUnit: null,
              supportedDestination: null,
            })),
          strategicSummary: '',
          agreements: [],
        };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });
  assert.ok(room.addPlayer('human-socket', 'Human', 'AUSTRIA'));
  for (const power of ['ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'] as Power[]) {
    assert.ok(room.addLlmPlayer({ power, provider: 'OPENAI', model: 'decision-model' }));
  }
  assert.equal(room.updateGameSettings({
    llmNegotiationInitiators: 1,
    llmNegotiationMaxMessages: 4,
    llmNegotiationWarningAtMessages: 3,
    llmNegotiationPlannerModel: 'planner-model',
  }), true);

  assert.equal(await room.startGame(), true);
  await room.submitOrders('AUSTRIA', []);

  assert.deepEqual(replyMessageNumbers, [2, 3, 4]);
  assert.equal(
    room.getLlmRunArtifacts().filter(artifact =>
      artifact.purpose === 'DIPLOMACY' &&
      artifact.year === 1901 &&
      artifact.season === 'SPRING'
    ).length,
    4
  );
  assert.ok(modelsByPurpose.includes('planner-model'));
  assert.ok(modelsByPurpose.includes('decision-model'));
});

test('turn-start outreach to a human is remembered when ignored', async () => {
  let englandSawIgnoredOutreach = false;
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context, eligiblePowers) {
        return {
          toPower: eligiblePowers.includes('AUSTRIA') ? 'AUSTRIA' : null,
          message: eligiblePowers.includes('AUSTRIA')
            ? 'Austria, we should speak before orders are final.'
            : '',
          expectsReply: true,
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        return {
          reply: 'Acknowledged.',
          expectsReply: false,
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestOrders(context) {
        if (power === 'ENGLAND') {
          englandSawIgnoredOutreach = /Outreach ENGLAND -> AUSTRIA was ignored/i
            .test(context.memory.diplomaticContext);
        }
        return {
          actions: context.state.units
            .filter(unit => unit.power === power && !unit.mustRetreat)
            .map(unit => ({
              id: `${power}-${unit.id}`,
              power,
              unitTerritory: unit.territory,
              unitCoast: unit.coast,
              type: 'HOLD' as const,
              targetTerritory: null,
              targetCoast: null,
              supportedUnit: null,
              supportedDestination: null,
            })),
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });

  assert.ok(room.addPlayer('austria-socket', 'Austria', 'AUSTRIA'));
  assert.ok(room.addLlmPlayer({ power: 'ENGLAND', provider: 'OPENAI', model: 'test-model' }));
  for (const power of ['FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'] as Power[]) {
    assert.ok(room.addLlmPlayer({ power }));
  }

  assert.equal(await room.startGame(), true);
  await waitFor(() => room.getLlmOutreachRequests('AUSTRIA').length === 1);
  await room.submitOrders('AUSTRIA', []);

  const request = room.getLlmOutreachRequests('AUSTRIA')[0];
  assert.equal(request.status, 'IGNORED');
  assert.equal(englandSawIgnoredOutreach, true);
});

test('order controllers receive deterministic tactical move suggestions', async () => {
  let sawMoveSuggestion = false;
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context) {
        return {
          toPower: null,
          message: '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        return {
          reply: 'Acknowledged.',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestOrders(context) {
        if (power === 'ENGLAND') {
          sawMoveSuggestion = Boolean(
            context.moveSuggestions?.some(suggestion =>
              suggestion.id.includes('move') &&
              suggestion.orderIds.some(orderId => orderId.includes('|MOVE|'))
            )
          );
        }
        return {
          actions: context.state.units
            .filter(unit => unit.power === power && !unit.mustRetreat)
            .map(unit => ({
              id: `${power}-${unit.id}`,
              power,
              unitTerritory: unit.territory,
              unitCoast: unit.coast,
              type: 'HOLD' as const,
              targetTerritory: null,
              targetCoast: null,
              supportedUnit: null,
              supportedDestination: null,
            })),
          strategicSummary: '',
          agreements: [],
        };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });

  assert.ok(room.addPlayer('austria-socket', 'Austria', 'AUSTRIA'));
  for (const power of ['ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'] as Power[]) {
    assert.ok(room.addLlmPlayer({ power }));
  }

  assert.equal(await room.startGame(), true);
  await room.submitOrders('AUSTRIA', []);

  assert.equal(sawMoveSuggestion, true);
});

test('LLM artifacts record model role and estimated cost', async () => {
  const room = new GameRoom({
    enforceLlmPolicy: true,
    llmPolicy: buildLlmRuntimePolicy({
      LLM_ALLOWED_PROVIDERS: 'STUB,OPENAI',
      LLM_ALLOWED_MODELS_OPENAI: 'gpt-5.4-mini',
      LLM_MAX_GAME_COST_USD: '1',
    }),
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context) {
        return {
          toPower: null,
          message: '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        return {
          reply: 'Acknowledged.',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestOrders(context) {
        return {
          actions: context.state.units
            .filter(unit => unit.power === power && !unit.mustRetreat)
            .map(unit => ({
              id: `${power}-${unit.id}`,
              power,
              unitTerritory: unit.territory,
              unitCoast: unit.coast,
              type: 'HOLD' as const,
              targetTerritory: null,
              targetCoast: null,
              supportedUnit: null,
              supportedDestination: null,
            })),
          strategicSummary: '',
          agreements: [],
          usage: { inputTokens: 1_000, outputTokens: 1_000 },
        };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });

  assert.ok(room.addPlayer('austria-socket', 'Austria', 'AUSTRIA'));
  assert.ok(room.addLlmPlayer({ power: 'ENGLAND', provider: 'OPENAI', model: 'gpt-5.4-mini' }));
  for (const power of ['FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'] as Power[]) {
    assert.ok(room.addLlmPlayer({ power }));
  }
  assert.equal(room.updateLlmNegotiationInitiators(0), true);

  assert.equal(await room.startGame(), true);
  await room.submitOrders('AUSTRIA', []);

  const artifact = room.getLlmRunArtifacts('ENGLAND').find(
    candidate => candidate.purpose === 'ORDERS'
  );
  assert.ok(artifact);
  assert.equal(artifact.modelRole, 'ORDERS');
  assert.equal(artifact.model, 'gpt-5.4-mini');
  assert.equal(artifact.inputTokens, 1_000);
  assert.equal(artifact.outputTokens, 1_000);
  assert.ok((artifact.estimatedCostUsd ?? 0) > 0);
  assert.equal(artifact.boardContextVersion, 'standard-board-v1');
  assert.ok((artifact.legalOrderCount ?? 0) > 0);
  assert.equal(artifact.selectedLegalOrderIds.length, 3);
  assert.ok(artifact.selectedLegalOrderIds.every(id => id.endsWith('|HOLD')));
});

test('LLM diplomatic replies can run concurrently for disjoint powers', async () => {
  let activeReplies = 0;
  let maxActiveReplies = 0;
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context) {
        return {
          toPower: null,
          message: '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        activeReplies++;
        maxActiveReplies = Math.max(maxActiveReplies, activeReplies);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeReplies--;
        return {
          reply: 'Acknowledged.',
          expectsReply: false,
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestOrders() {
        return { actions: [], strategicSummary: '', agreements: [] };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });
  assert.ok(room.addPlayer('france-socket', 'France', 'FRANCE'));
  assert.ok(room.addPlayer('england-socket', 'England', 'ENGLAND'));
  assert.ok(room.addLlmPlayer({ power: 'GERMANY', provider: 'OPENAI' }));
  assert.ok(room.addLlmPlayer({ power: 'ITALY', provider: 'OPENAI' }));

  await Promise.all([
    room.sendDiplomaticMessage('FRANCE', 'GERMANY', 'Can we coordinate?'),
    room.sendDiplomaticMessage('ENGLAND', 'ITALY', 'Can we coordinate?'),
  ]);

  assert.equal(maxActiveReplies, 2);
});

test('LLM diplomatic replies serialize when conversations share a power', async () => {
  let activeReplies = 0;
  let maxActiveReplies = 0;
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context) {
        return {
          toPower: null,
          message: '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        activeReplies++;
        maxActiveReplies = Math.max(maxActiveReplies, activeReplies);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeReplies--;
        return {
          reply: 'Acknowledged.',
          expectsReply: false,
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestOrders() {
        return { actions: [], strategicSummary: '', agreements: [] };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });
  assert.ok(room.addPlayer('france-socket', 'France', 'FRANCE'));
  assert.ok(room.addPlayer('england-socket', 'England', 'ENGLAND'));
  assert.ok(room.addLlmPlayer({ power: 'GERMANY', provider: 'OPENAI' }));

  await Promise.all([
    room.sendDiplomaticMessage('FRANCE', 'GERMANY', 'Can we coordinate?'),
    room.sendDiplomaticMessage('ENGLAND', 'GERMANY', 'Can we coordinate?'),
  ]);

  assert.equal(maxActiveReplies, 1);
});

test('conversation presence hides private pairings from uninvolved players', async () => {
  let releaseReply!: () => void;
  const replyGate = new Promise<void>(resolve => {
    releaseReply = resolve;
  });
  const presenceBySocket = new Map<string, ConversationPresencePayload[]>();
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context) {
        return {
          toPower: null,
          message: '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        await replyGate;
        return {
          reply: 'Acknowledged.',
          expectsReply: false,
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestOrders() {
        return { actions: [], strategicSummary: '', agreements: [] };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });
  room.setIO({
    to(socketId: string) {
      return {
        emit(event: string, payload: ConversationPresencePayload) {
          if (event !== 'conversation_presence') return;
          const events = presenceBySocket.get(socketId) ?? [];
          events.push(payload);
          presenceBySocket.set(socketId, events);
        },
      };
    },
  } as unknown as Parameters<GameRoom['setIO']>[0]);
  assert.ok(room.addPlayer('france-socket', 'France', 'FRANCE'));
  assert.ok(room.addPlayer('england-socket', 'England', 'ENGLAND'));
  assert.ok(room.addLlmPlayer({ power: 'GERMANY', provider: 'OPENAI' }));

  const pendingReply = room.sendDiplomaticMessage(
    'FRANCE',
    'GERMANY',
    'Can we coordinate?'
  );
  await new Promise<void>(resolve => setImmediate(resolve));

  const francePresence = presenceBySocket.get('france-socket')?.at(-1);
  const englandPresence = presenceBySocket.get('england-socket')?.at(-1);
  assert.equal(francePresence?.active, true);
  assert.deepEqual(francePresence?.participants, ['FRANCE', 'GERMANY']);
  assert.equal(englandPresence?.active, true);
  assert.equal(englandPresence?.participants, null);

  releaseReply();
  await pendingReply;
  assert.equal(presenceBySocket.get('england-socket')?.at(-1)?.active, false);
});

test('LLM phase-decision diagnostics are delivered to the host only by default', async () => {
  const llmStatusBySocket = new Map<string, unknown[]>();
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context) {
        return {
          toPower: null,
          message: '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        return {
          reply: 'Acknowledged.',
          expectsReply: false,
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestOrders() {
        return { actions: [], strategicSummary: '', agreements: [] };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });
  room.setIO({
    to(socketId: string) {
      return {
        emit(event: string, payload: unknown) {
          if (event !== 'llm_status') return;
          const events = llmStatusBySocket.get(socketId) ?? [];
          events.push(payload);
          llmStatusBySocket.set(socketId, events);
        },
      };
    },
  } as unknown as Parameters<GameRoom['setIO']>[0]);
  assert.ok(room.addPlayer('host-socket', 'Host', 'FRANCE'));
  assert.ok(room.addPlayer('england-socket', 'England', 'ENGLAND'));
  for (const power of ['AUSTRIA', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'] as Power[]) {
    assert.ok(room.addLlmPlayer({ power, provider: 'OPENAI' }));
  }
  assert.equal(room.updateGameSettings({ llmNegotiationInitiators: 0 }), true);

  assert.equal(await room.startGame(), true);
  await room.submitOrders('FRANCE', []);
  await room.submitOrders('ENGLAND', []);

  assert.ok((llmStatusBySocket.get('host-socket')?.length ?? 0) > 0);
  assert.equal(llmStatusBySocket.get('england-socket'), undefined);
});

test('an all-LLM room can resolve its opening phase without a human submission', async () => {
  const room = new GameRoom();
  for (const power of ALL_TEST_POWERS) {
    assert.ok(room.addLlmPlayer({ power }));
  }

  assert.equal(await room.startGame(), true);
  assert.equal(room.getState().status, 'IN_PROGRESS');
  assert.equal(room.getState().season, 'FALL');
  assert.equal(room.getState().phase, 'ORDERS');
  const history = room.getPhaseHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].phase, 'ORDERS');
  assert.equal(history[0].year, 1901);
  assert.equal(history[0].season, 'SPRING');
  if (history[0].phase === 'ORDERS') {
    assert.equal(history[0].resolvedOrders.length, 22);
    assert.equal(history[0].before.units.length, 22);
    assert.equal(history[0].after.units.length, 22);
  }

  history[0].before.units.length = 0;
  assert.equal(room.getPhaseHistory()[0].before.units.length, 22);
});

test('retreat resolution is recorded as a public phase report', async () => {
  const room = humanRoom();
  assert.equal(await room.startGame(), true);
  const state = room.getState();
  state.units = [
    testUnit('austria-vie', 'AUSTRIA', 'ARMY', 'VIE'),
    testUnit('germany-boh', 'GERMANY', 'ARMY', 'BOH'),
    testUnit('germany-tyr', 'GERMANY', 'ARMY', 'TYR'),
  ];

  await room.submitOrders('AUSTRIA', [testOrder('AUSTRIA', 'VIE', 'HOLD')]);
  await room.submitOrders('GERMANY', [
    testOrder('GERMANY', 'BOH', 'MOVE', 'VIE'),
    {
      ...testOrder('GERMANY', 'TYR', 'SUPPORT_MOVE'),
      supportedUnit: 'BOH',
      supportedDestination: 'VIE',
    },
  ]);

  assert.equal(room.getState().phase, 'RETREATS');
  const dislodged = room.getState().units.find(unit => unit.mustRetreat);
  assert.ok(dislodged);
  await room.submitRetreats('AUSTRIA', { [dislodged.id]: null });

  const history = room.getPhaseHistory();
  assert.deepEqual(history.map(report => report.phase), ['ORDERS', 'RETREATS']);
  const retreatReport = history[1];
  assert.equal(retreatReport.phase, 'RETREATS');
  if (retreatReport.phase === 'RETREATS') {
    assert.equal(retreatReport.retreats.length, 1);
    assert.equal(retreatReport.retreats[0].fromTerritory, 'VIE');
    assert.equal(retreatReport.retreats[0].outcome, 'DISBANDED');
    assert.deepEqual(retreatReport.ownershipChanges, []);
    assert.equal(retreatReport.after.units.some(unit => unit.id === dislodged.id), false);
  }
});

test('Fall occupation captures supply centers and is reported publicly', async () => {
  const room = humanRoom();
  assert.equal(await room.startGame(), true);
  const state = room.getState();
  state.season = 'FALL';
  state.phase = 'ORDERS';
  state.units = [testUnit('austria-bud', 'AUSTRIA', 'ARMY', 'BUD')];
  for (const territory of Object.values(state.territories)) territory.owner = null;

  await room.submitOrders('AUSTRIA', [
    testOrder('AUSTRIA', 'BUD', 'MOVE', 'RUM'),
  ]);

  assert.equal(room.getState().territories.RUM.owner, 'AUSTRIA');
  const report = room.getPhaseHistory()[0];
  assert.equal(report.phase, 'ORDERS');
  if (report.phase === 'ORDERS') {
    assert.deepEqual(report.ownershipChanges, [{
      territory: 'RUM',
      fromPower: null,
      toPower: 'AUSTRIA',
    }]);
    assert.deepEqual(report.resolvedOrders.map(order => order.resolution), ['SUCCEEDS']);
  }
});

test('captured supply centers stay owned after the unit leaves in Spring', async () => {
  const room = humanRoom();
  assert.equal(await room.startGame(), true);
  const state = room.getState();
  state.season = 'SPRING';
  state.phase = 'ORDERS';
  state.units = [testUnit('austria-rum', 'AUSTRIA', 'ARMY', 'RUM')];
  for (const territory of Object.values(state.territories)) territory.owner = null;
  state.territories.RUM.owner = 'AUSTRIA';

  await room.submitOrders('AUSTRIA', [
    testOrder('AUSTRIA', 'RUM', 'MOVE', 'UKR'),
  ]);

  assert.equal(room.getState().territories.RUM.owner, 'AUSTRIA');
  const report = room.getPhaseHistory()[0];
  assert.equal(report.phase, 'ORDERS');
  if (report.phase === 'ORDERS') {
    assert.deepEqual(report.ownershipChanges, []);
  }
});

test('Spring-only occupation does not capture a supply center vacated in Fall', async () => {
  const room = humanRoom();
  assert.equal(await room.startGame(), true);
  const state = room.getState();
  state.season = 'FALL';
  state.phase = 'ORDERS';
  state.units = [testUnit('austria-rum', 'AUSTRIA', 'ARMY', 'RUM')];
  for (const territory of Object.values(state.territories)) territory.owner = null;

  await room.submitOrders('AUSTRIA', [
    testOrder('AUSTRIA', 'RUM', 'MOVE', 'UKR'),
  ]);

  assert.equal(room.getState().territories.RUM.owner, null);
  const report = room.getPhaseHistory()[0];
  assert.equal(report.phase, 'ORDERS');
  if (report.phase === 'ORDERS') {
    assert.deepEqual(report.ownershipChanges, []);
  }
});

test('Fall retreats can capture unoccupied supply centers', async () => {
  const room = humanRoom();
  assert.equal(await room.startGame(), true);
  const state = room.getState();
  state.season = 'FALL';
  state.phase = 'RETREATS';
  for (const territory of Object.values(state.territories)) territory.owner = null;
  state.units = [{
    ...testUnit('austria-ser', 'AUSTRIA', 'ARMY', 'SER'),
    mustRetreat: true,
    retreatOptions: ['RUM'],
  }];
  state.lastAdjudicationResult = {
    resolvedOrders: [],
    standoffTerritories: [],
    dislodgedUnits: [],
    destroyedUnits: [],
    newTerritoryOwnership: {},
    buildCounts: {} as Record<Power, number>,
  };

  await room.submitRetreats('AUSTRIA', {
    'austria-ser': { territory: 'RUM', coast: null },
  });

  assert.equal(room.getState().territories.RUM.owner, 'AUSTRIA');
  const report = room.getPhaseHistory()[0];
  assert.equal(report.phase, 'RETREATS');
  if (report.phase === 'RETREATS') {
    assert.equal(report.retreats[0].outcome, 'RETREATED');
    assert.deepEqual(report.ownershipChanges, [{
      territory: 'RUM',
      fromPower: null,
      toPower: 'AUSTRIA',
    }]);
  }
  assert.deepEqual(state.lastAdjudicationResult?.newTerritoryOwnership, {
    RUM: 'AUSTRIA',
  });
});

test('builds, disbands, and waived builds are recorded publicly', async () => {
  const room = humanRoom();
  assert.equal(await room.startGame(), true);
  const state = room.getState();
  state.year = 1901;
  state.season = 'WINTER';
  state.phase = 'BUILDS';
  state.units = [];
  for (const territory of Object.values(state.territories)) territory.owner = null;
  state.territories.VIE.owner = 'AUSTRIA';
  state.territories.BUD.owner = 'AUSTRIA';

  await room.submitBuilds('AUSTRIA', {
    gameId: room.gameId,
    builds: [{ type: 'ARMY', territory: 'VIE', coast: null }],
    disbands: [],
  });

  const report = room.getPhaseHistory()[0];
  assert.equal(report.phase, 'BUILDS');
  if (report.phase === 'BUILDS') {
    assert.equal(report.adjustments.length, 1);
    assert.equal(report.adjustments[0].builds[0].territory, 'VIE');
    assert.equal(report.adjustments[0].waivedBuilds, 1);
    assert.equal(report.after.units.length, 1);
  }
});

test('diplomatic messages reject empty, oversized, and self-directed content', () => {
  const room = new GameRoom();
  const austria = room.addPlayer('austria-socket', 'Austria', 'AUSTRIA');
  const england = room.addPlayer('england-socket', 'England', 'ENGLAND');
  assert.ok(austria);
  assert.ok(england);

  assert.match(
    room.validateDiplomaticMessage(austria.player.power, england.player.power, '   ') ?? '',
    /empty/
  );
  assert.match(
    room.validateDiplomaticMessage(austria.player.power, austria.player.power, 'Hello') ?? '',
    /another power/
  );
  assert.match(
    room.validateDiplomaticMessage(
      austria.player.power,
      england.player.power,
      'x'.repeat(2001)
    ) ?? '',
    /2000/
  );
});

function invalidOrderController(
  power: Power,
  attempts: Map<Power, number>
): PowerController {
  return {
    power,
    async requestDiplomaticInitiative(context) {
      return {
        toPower: null,
        message: '',
        strategicSummary: context.memory.strategicSummary,
        agreements: context.memory.agreements,
      };
    },
    async requestDiplomaticReply(context) {
      return {
        reply: 'Acknowledged.',
        strategicSummary: context.memory.strategicSummary,
        agreements: context.memory.agreements,
      };
    },
    async requestOrders(context) {
      attempts.set(power, (attempts.get(power) ?? 0) + 1);
      return {
        actions: context.state.units
          .filter(unit => unit.power === power)
          .map(unit => ({
            id: `${power}-${unit.id}`,
            power,
            unitTerritory: unit.territory,
            unitCoast: unit.coast,
            type: 'MOVE' as const,
            targetTerritory: 'NOT_A_TERRITORY',
            targetCoast: null,
            supportedUnit: null,
            supportedDestination: null,
          })),
        strategicSummary: 'Attempted invalid moves.',
        agreements: [],
      };
    },
    async requestRetreats() {
      return { actions: {}, strategicSummary: '', agreements: [] };
    },
    async requestBuilds() {
      return {
        actions: { builds: [], disbands: [] },
        strategicSummary: '',
        agreements: [],
      };
    },
  };
}

const ALL_TEST_POWERS: Power[] = [
  'AUSTRIA',
  'ENGLAND',
  'FRANCE',
  'GERMANY',
  'ITALY',
  'RUSSIA',
  'TURKEY',
];

function humanRoom(): GameRoom {
  const room = new GameRoom();
  for (const [index, power] of ALL_TEST_POWERS.entries()) {
    assert.ok(room.addPlayer(`socket-${index}`, power, power));
  }
  return room;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      assert.fail('Timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function testUnit(
  id: string,
  power: Power,
  type: 'ARMY' | 'FLEET',
  territory: TerritoryId
): Unit {
  return {
    id,
    power,
    type,
    territory,
    coast: null,
    mustRetreat: false,
    retreatOptions: [],
    retreatCoasts: {},
    dislodgedBy: null,
  };
}

function testOrder(
  power: Power,
  unitTerritory: TerritoryId,
  type: Order['type'],
  targetTerritory: TerritoryId | null = null
): Order {
  return {
    id: `${power}-${unitTerritory}-${type}`,
    power,
    unitTerritory,
    unitCoast: null,
    type,
    targetTerritory,
    targetCoast: null,
    supportedUnit: null,
    supportedDestination: null,
  };
}
