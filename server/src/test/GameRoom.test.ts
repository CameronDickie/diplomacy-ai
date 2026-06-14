import assert from 'node:assert/strict';
import test from 'node:test';
import type { Order } from '@diplomacy/shared';
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

test('players cannot join after a game starts', () => {
  const room = new GameRoom();
  for (let index = 0; index < 7; index++) {
    assert.ok(room.addPlayer(`socket-${index}`, `Player ${index}`));
  }
  assert.equal(room.startGame(), true);
  assert.equal(room.addPlayer('late-socket', 'Late Player'), null);
});

test('a human can advance an opening turn with six automated players', () => {
  const room = new GameRoom();
  const human = room.addPlayer('human-socket', 'Human');
  assert.ok(human);

  for (let index = 0; index < 6; index++) {
    assert.ok(room.addLlmPlayer());
  }

  assert.equal(room.startGame(), true);
  assert.doesNotThrow(() => room.submitOrders(human.player.power, []));

  const state = room.getState();
  assert.equal(state.year, 1901);
  assert.equal(state.season, 'FALL');
  assert.equal(state.phase, 'ORDERS');
  assert.equal(state.status, 'IN_PROGRESS');
});

test('orders cannot be issued for another power', () => {
  const room = new GameRoom();
  const austria = room.addPlayer('austria-socket', 'Austria');
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
  const austria = room.addPlayer('austria-socket', 'Austria');
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

test('diplomacy stays private while LLM memory spans all of its conversations', () => {
  const room = new GameRoom();
  assert.ok(room.addPlayer('austria-socket', 'Austria'));
  assert.ok(room.addPlayer('england-socket', 'England'));
  assert.ok(room.addPlayer('france-socket', 'France'));
  const germany = room.addLlmPlayer();
  assert.ok(germany);
  assert.equal(germany.power, 'GERMANY');

  const frenchExchange = room.sendDiplomaticMessage(
    'FRANCE',
    'GERMANY',
    'I propose a non-aggression pact over Burgundy.'
  );
  const englishExchange = room.sendDiplomaticMessage(
    'GERMANY',
    'ENGLAND',
    'France proposed a non-aggression pact over Burgundy.'
  );

  assert.equal(frenchExchange.length, 2);
  assert.equal(englishExchange.length, 1);
  assert.equal(room.getDiplomaticMessages('AUSTRIA').length, 0);
  assert.equal(room.getDiplomaticMessages('FRANCE').length, 2);
  assert.equal(room.getDiplomaticMessages('ENGLAND').length, 1);
  assert.equal(room.getDiplomaticMessages('GERMANY').length, 3);

  const memory = room.getLlmDiplomacyMemory('GERMANY');
  assert.ok(memory);
  assert.equal(memory.revision, 3);
  assert.match(memory.diplomaticContext, /FRANCE -> GERMANY: I propose a non-aggression pact/);
  assert.match(memory.diplomaticContext, /GERMANY -> ENGLAND: France proposed/);
  assert.equal(memory.messageIdsByPower.FRANCE?.length, 2);
  assert.equal(memory.messageIdsByPower.ENGLAND?.length, 1);
});

test('diplomatic messages reject empty, oversized, and self-directed content', () => {
  const room = new GameRoom();
  const austria = room.addPlayer('austria-socket', 'Austria');
  const england = room.addPlayer('england-socket', 'England');
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
