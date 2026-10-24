import assert from 'node:assert/strict';
import test from 'node:test';
import { GameManager } from '../GameManager.js';

test('an account hosts one unfinished game at a time, and an abandoned one gives way to a new one', () => {
  const manager = new GameManager({}, { maxRooms: 5, maxRoomsPerAccount: 1 });
  assert.equal(manager.refusal('alice', true), null);
  const first = manager.createGame('alice');
  first.addPlayer('socket-a', 'Alice', 'RANDOM');
  assert.equal(manager.refusal('alice', true), 'HOSTING_LIMIT');
  assert.equal(manager.refusal('bob', true), null, 'another account is not limited by alice');
  assert.equal(manager.refusal('alice', false), null, 'outside showcase only the total applies');
  first.markDisconnected('socket-a');
  assert.equal(manager.refusal('alice', true), null);
  assert.equal(manager.getRoom(first.gameId), undefined, 'the abandoned game was given up');
  manager.createGame('alice').addPlayer('socket-b', 'Alice', 'RANDOM');
  manager.dispose();
});

test('a full server gives up abandoned games first and otherwise refuses', () => {
  const manager = new GameManager({}, { maxRooms: 2, maxRoomsPerAccount: 1 });
  const kept = manager.createGame('alice'); kept.addPlayer('socket-a', 'Alice', 'RANDOM');
  const empty = manager.createGame('bob');
  assert.equal(manager.refusal('carol', true), null);
  assert.equal(manager.getRoom(empty.gameId), undefined);
  assert.ok(manager.getRoom(kept.gameId));
  manager.createGame('carol').addPlayer('socket-c', 'Carol', 'RANDOM');
  assert.equal(manager.refusal('dave', true), 'SERVER_FULL');
  assert.equal(manager.refusal(null, false), 'SERVER_FULL', 'the total applies to everyone');
  manager.dispose();
});
