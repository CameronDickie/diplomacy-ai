import assert from 'node:assert/strict';
import test from 'node:test';
import type { Order, Power, PublicPhaseReport, TerritoryId } from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import { GameRoom } from '../GameRoom.js';
import { describeChallengeScore, scoreChallenge, TUNIS_PILOT_V1 } from '../challenge/TunisPilot.js';

async function offlineGame(): Promise<GameRoom> {
  const room = new GameRoom();
  for (const power of ALL_POWERS) {
    assert.ok(room.addPlayer(`socket-${power}`, power, power));
  }
  assert.equal(await room.startGame(), true);
  return room;
}

async function playSeason(
  room: GameRoom,
  turkeyMoves: readonly { from: TerritoryId; to: TerritoryId }[] = []
): Promise<void> {
  const before = { year: room.getState().year, season: room.getState().season };
  for (const power of ALL_POWERS) {
    const orders: Order[] = room.getState().units
      .filter(unit => unit.power === power && !unit.mustRetreat)
      .map(unit => {
        const target = power === 'TURKEY'
          ? turkeyMoves.find(move => move.from === unit.territory)?.to ?? null
          : null;
        return {
          id: `fixture-${before.year}-${before.season}-${unit.id}`,
          power,
          unitTerritory: unit.territory,
          unitCoast: unit.coast,
          type: target ? 'MOVE' : 'HOLD',
          targetTerritory: target,
          targetCoast: null,
          supportedUnit: null,
          supportedDestination: null,
        };
      });
    await room.submitOrders(power, orders);
  }
  assert.equal(room.getPhaseHistory().at(-1)?.season, before.season);
}

function score(room: GameRoom, lifecycle: 'ACTIVE' | 'ABANDONED' | 'GAME_FINISHED' = 'ACTIVE') {
  return scoreChallenge(TUNIS_PILOT_V1, {
    challengeId: TUNIS_PILOT_V1.id,
    challengeVersion: TUNIS_PILOT_V1.version,
    lifecycle,
    reports: room.getPhaseHistory(),
  });
}

test('Godip can reach and capture Tunis from the standard Turkish start before the deadline', async () => {
  const room = await offlineGame();
  await playSeason(room, [
    { from: 'SMY', to: 'ARM' },
    { from: 'CON', to: 'SMY' },
    { from: 'ANK', to: 'CON' },
  ]);
  await playSeason(room, [{ from: 'CON', to: 'AEG' }]);
  await playSeason(room, [{ from: 'AEG', to: 'ION' }]);
  assert.equal(score(room).outcome, 'INCOMPLETE', 'the route has not captured Tunis');
  assert.equal(room.getState().territories.TUN.owner, null);

  await playSeason(room, [{ from: 'ION', to: 'TUN' }]);
  assert.equal(room.getState().territories.TUN.owner, 'TURKEY');
  assert.deepEqual(score(room), {
    outcome: 'SUCCESS', reason: 'OBJECTIVE_MET', completedYear: 1902,
    achievementIds: ['EARLY_CAPTURE'], tie: 'NOT_POSSIBLE',
  });
  assert.match(describeChallengeScore(TUNIS_PILOT_V1, score(room)), /Early capture achieved/);
  const replay = await offlineGame();
  await playSeason(replay, [
    { from: 'SMY', to: 'ARM' }, { from: 'CON', to: 'SMY' }, { from: 'ANK', to: 'CON' },
  ]);
  await playSeason(replay, [{ from: 'CON', to: 'AEG' }]);
  await playSeason(replay, [{ from: 'AEG', to: 'ION' }]);
  await playSeason(replay, [{ from: 'ION', to: 'TUN' }]);
  assert.deepEqual(score(room), score(replay), 'same opening and orders score alike across rooms');
});

test('Spring occupation alone does not count and Fall 1903 is still on time', async () => {
  const room = await offlineGame();
  await playSeason(room, [
    { from: 'SMY', to: 'ARM' }, { from: 'CON', to: 'SMY' }, { from: 'ANK', to: 'CON' },
  ]);
  await playSeason(room, [{ from: 'CON', to: 'AEG' }]);
  await playSeason(room, [{ from: 'AEG', to: 'ION' }]);
  await playSeason(room);
  await playSeason(room, [{ from: 'ION', to: 'TUN' }]);
  assert.equal(room.getState().units.some(unit => unit.power === 'TURKEY' && unit.territory === 'TUN'), true);
  assert.equal(room.getState().territories.TUN.owner, null);
  assert.equal(score(room).outcome, 'INCOMPLETE');
  await playSeason(room);
  assert.deepEqual(score(room), {
    outcome: 'SUCCESS', reason: 'OBJECTIVE_MET', completedYear: 1903,
    achievementIds: [], tie: 'NOT_POSSIBLE',
  });
});

test('holding through Fall 1903 reaches the objective deadline without a provider or clock', async () => {
  const room = await offlineGame();
  for (let index = 0; index < 5; index++) {
    await playSeason(room);
  }
  assert.equal(score(room).outcome, 'INCOMPLETE');
  await playSeason(room);
  assert.deepEqual(score(room), {
    outcome: 'FAILURE', reason: 'DEADLINE', completedYear: 1903,
    achievementIds: [], tie: 'NOT_POSSIBLE',
  });
  assert.match(describeChallengeScore(TUNIS_PILOT_V1, score(room)), /Fall 1903/);
});

test('Fall with retreats remains incomplete until final ownership is recorded', async () => {
  const room = await offlineGame();
  await playSeason(room);
  await playSeason(room);
  const fall = room.getPhaseHistory().at(-1);
  assert.ok(fall && fall.phase === 'ORDERS');
  const pendingFall = {
    ...fall,
    dislodgedUnits: [room.getState().units[0]],
  };
  const attempt = {
    challengeId: TUNIS_PILOT_V1.id,
    challengeVersion: TUNIS_PILOT_V1.version,
    lifecycle: 'ACTIVE' as const,
    reports: [pendingFall] as PublicPhaseReport[],
  };
  assert.equal(scoreChallenge(TUNIS_PILOT_V1, attempt).outcome, 'INCOMPLETE');
  attempt.reports.push({
    id: 'settled-retreat', sequence: fall.sequence + 1,
    year: fall.year, season: 'FALL', phase: 'RETREATS', resolvedAt: fall.resolvedAt,
    before: fall.after,
    after: { ...fall.after, territoryOwners: { ...fall.after.territoryOwners, TUN: 'TURKEY' } },
    retreats: [], ownershipChanges: [{ territory: 'TUN', fromPower: null, toPower: 'TURKEY' }],
  });
  assert.equal(scoreChallenge(TUNIS_PILOT_V1, attempt).outcome, 'SUCCESS');
});

test('abandonment and version mismatch are explicit', async () => {
  const room = await offlineGame();
  assert.equal(score(room, 'ABANDONED').outcome, 'ABANDONED');
  assert.equal(score(room, 'GAME_FINISHED').reason, 'GAME_FINISHED');
  assert.throws(() => scoreChallenge(TUNIS_PILOT_V1, {
    challengeId: TUNIS_PILOT_V1.id,
    challengeVersion: 2,
    lifecycle: 'ACTIVE',
    reports: [],
  }), /version/);
});
