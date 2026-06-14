import assert from 'node:assert/strict';
import test from 'node:test';
import type { Order, Power } from '@diplomacy/shared';
import type { PowerController } from '../llm/PowerController.js';
import { CONTROLLER_SYSTEM_PROMPT } from '../llm/PromptBuilder.js';
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
  assert.equal(room.updateLlmNegotiationInitiators(5), true);
  assert.equal(room.getState().settings.llmNegotiationInitiators, 5);
  assert.equal(room.updateLlmNegotiationInitiators(-1), false);
  assert.equal(room.updateLlmNegotiationInitiators(8), false);
  assert.equal(room.updateLlmNegotiationInitiators(1.5), false);
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
        return {
          toPower: eligiblePowers[0] ?? null,
          message: eligiblePowers.length > 0
            ? `I want to coordinate with ${eligiblePowers[0]}.`
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

  assert.equal(initiatives.length, 4);
  assert.equal(replies.length, 4);
  assert.equal(
    room.getLlmRunArtifacts().filter(artifact => artifact.purpose === 'DIPLOMACY').length,
    8
  );
  assert.ok([...orderMessageCounts.values()].some(count => count > 0));
  assert.equal(room.getState().season, 'FALL');
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
