import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_POWERS, gamePhaseId, type PhaseSubmission } from '@diplomacy/shared';
import { GameRoom } from '../GameRoom.js';

function startedRoom(): GameRoom {
  const room = new GameRoom();
  for (const power of ALL_POWERS) room.addPlayer(power, power, power);
  room.getState().status = 'IN_PROGRESS';
  return room;
}

test('accepted orders are restored on resume, and duplicate IDs cannot change the command', async () => {
  const room = startedRoom();
  const command: PhaseSubmission = { phase: 'ORDERS', phaseId: gamePhaseId(room.getState()), requestId: 'orders-one', orders: [] };
  const first = await room.submitCommand('FRANCE', command);
  assert.equal(first.status, 'ACCEPTED');
  assert.deepEqual(await room.submitCommand('FRANCE', command), first);
  room.markDisconnected('FRANCE');
  assert.deepEqual(room.getSubmissionState('FRANCE'), first);
  const changed = await room.submitCommand('FRANCE', { ...command, phaseId: 'different-phase' });
  assert.equal(changed.error?.code, 'REQUEST_ID_REUSED');
  assert.deepEqual(room.getSubmissionState('FRANCE'), first);
  first.status = 'FAILED';
  assert.equal(room.getSubmissionState('FRANCE').status, 'ACCEPTED', 'returned receipts must not expose mutable server state');
});

test('concurrent copies of an in-flight request run once and a second ID cannot replace it', async () => {
  const room = startedRoom();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  room.submitOrders = async () => { attempts++; await gate; };
  const command: PhaseSubmission = { phase: 'ORDERS', phaseId: gamePhaseId(room.getState()), requestId: 'in-flight', orders: [] };
  const first = room.submitCommand('FRANCE', command);
  const duplicate = room.submitCommand('FRANCE', command);
  assert.equal(room.getSubmissionState('FRANCE').status, 'SUBMITTING');
  const replacement = await room.submitCommand('FRANCE', { ...command, requestId: 'replacement' });
  assert.equal(replacement.requestId, command.requestId);
  assert.equal(attempts, 1);
  release();
  assert.deepEqual(await duplicate, await first);
  assert.equal(attempts, 1);
});

test('failed resolution is retryable with a new ID while replaying its receipt does not rerun it', async () => {
  const room = startedRoom();
  let attempts = 0;
  room.submitOrders = async () => { if (++attempts === 1) throw new Error('engine unavailable'); };
  const command: PhaseSubmission = { phase: 'ORDERS', phaseId: gamePhaseId(room.getState()), requestId: 'failed', orders: [] };
  const failure = await room.submitCommand('FRANCE', command);
  assert.equal(failure.status, 'FAILED');
  assert.equal(failure.error?.code, 'ADJUDICATION_FAILED');
  assert.deepEqual(await room.submitCommand('FRANCE', command), failure);
  assert.equal(attempts, 1);
  assert.equal((await room.submitCommand('FRANCE', { ...command, requestId: 'retry' })).status, 'ACCEPTED');
  assert.equal(attempts, 2);
});

test('completed receipts remain idempotent after phase advance while fresh stale commands fail', async () => {
  const room = startedRoom();
  const command: PhaseSubmission = { phase: 'ORDERS', phaseId: gamePhaseId(room.getState()), requestId: 'old-phase', orders: [] };
  const accepted = await room.submitCommand('FRANCE', command);
  room.getState().season = 'FALL';
  assert.deepEqual(await room.submitCommand('FRANCE', command), accepted);
  assert.equal(room.getSubmissionState('FRANCE').status, 'EDITING');
  assert.equal((await room.submitCommand('FRANCE', { ...command, requestId: 'stale' })).error?.code, 'STALE_PHASE');
});

test('retreat submission rejects illegal destinations, allows correction, and locks accepted decisions', async () => {
  const room = startedRoom();
  room.getState().phase = 'RETREATS';
  const unit = room.getState().units.find(unit => unit.power === 'FRANCE')!;
  const other = room.getState().units.find(unit => unit.power === 'ENGLAND')!;
  unit.mustRetreat = other.mustRetreat = true;
  unit.retreatOptions = ['PIC'];
  const command: PhaseSubmission = {
    phase: 'RETREATS', phaseId: gamePhaseId(room.getState()), requestId: 'bad-retreat',
    retreats: { [unit.id]: { territory: 'MOS', coast: null } },
  };
  assert.equal((await room.submitCommand('FRANCE', command)).error?.code, 'INVALID_RETREATS');
  const corrected = await room.submitCommand('FRANCE', { ...command, requestId: 'good-retreat', retreats: { [unit.id]: null } });
  assert.equal(corrected.status, 'ACCEPTED');
  assert.deepEqual(room.getSubmissionState('FRANCE'), corrected);
  assert.deepEqual(await room.submitCommand('FRANCE', { ...command, requestId: 'overwrite' }), corrected);
});

test('build rejection does not lock the player, and accepted adjustments survive reconnect status reads', async () => {
  const room = startedRoom();
  room.getState().phase = 'BUILDS';
  room.getState().season = 'WINTER';
  const unit = room.getState().units.find(unit => unit.power === 'FRANCE')!;
  const other = room.getState().units.find(unit => unit.power === 'ENGLAND')!;
  room.getState().units.push({ ...unit, id: 'extra-france', territory: 'GAS' }, { ...other, id: 'extra-england', territory: 'YOR' });
  const command: PhaseSubmission = {
    phase: 'BUILDS', phaseId: gamePhaseId(room.getState()), requestId: 'bad-build', builds: [], disbands: [other.id],
  };
  assert.equal((await room.submitCommand('FRANCE', command)).error?.code, 'INVALID_BUILDS');
  const corrected = await room.submitCommand('FRANCE', { ...command, requestId: 'good-build', disbands: ['extra-france'] });
  assert.equal(corrected.status, 'ACCEPTED');
  room.markDisconnected('FRANCE');
  assert.deepEqual(room.getSubmissionState('FRANCE'), corrected);
  const england = await room.submitCommand('ENGLAND', {
    ...command, requestId: 'england-disband', disbands: ['extra-england'],
  });
  assert.equal(england.status, 'ACCEPTED');
  assert.equal(room.getState().year, 1902);
  assert.equal(room.getState().phase, 'ORDERS');
  assert.equal(room.getState().units.some(unit => unit.id.startsWith('extra-')), false);
});
