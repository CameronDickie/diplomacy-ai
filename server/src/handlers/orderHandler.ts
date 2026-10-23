import type { Server, Socket } from 'socket.io';
import { gamePhaseId, type ClientToServerEvents, type PhaseSubmission, type ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';
import { requireRoomAccess } from './authz.js';
import { onClientEvent } from './clientEvent.js';

export function attachOrderHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  _io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager
): void {
  async function submit(gameId: string, command: PhaseSubmission): Promise<void> {
    const room = gameManager.getRoom(gameId);
    if (!room) {
      socket.emit('error', { message: 'Game not found', code: 'GAME_NOT_FOUND' });
      return;
    }
    if (!requireRoomAccess(socket, room)) return;
    const player = room.getPlayerBySocket(socket.id);
    if (!player) {
      socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
      return;
    }
    const result = room.submitCommand(player.power, command);
    socket.emit('submission_state', room.getSubmissionState(player.power));
    const outcome = await result;
    if (room.getPlayerBySocket(socket.id)?.id === player.id) {
      socket.emit('submission_state', outcome);
      if (outcome.error) socket.emit('error', outcome.error);
      socket.emit('game_state_sync', { gameState: room.getState() });
      socket.emit('submission_state', room.getSubmissionState(player.power));
    } else {
      // Resolution may finish after the submitting transport has been replaced.
      room.emitToPlayer(player.id, 'game_state_sync', { gameState: room.getState() });
      room.emitToPlayer(player.id, 'submission_state', room.getSubmissionState(player.power));
    }
  }

  // The same legal catalog the challenge uses, so a person chooses only orders the rules allow. It comes from
  // the room's per-phase cache, which also checks every submission and briefs AI players.
  onClientEvent(socket, 'request_legal_orders', async ({ gameId }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) { socket.emit('error', { message: 'Game not found', code: 'GAME_NOT_FOUND' }); return; }
    if (!requireRoomAccess(socket, room)) return;
    const player = room.getPlayerBySocket(socket.id);
    if (!player) { socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' }); return; }
    const state = room.getState();
    if (state.status !== 'IN_PROGRESS' || state.phase !== 'ORDERS') return;
    const phaseId = gamePhaseId(state);
    let options;
    try { options = await room.getLegalOrders(player.power); }
    catch { socket.emit('error', { message: 'Could not list the legal orders. Try again.', code: 'LEGAL_ORDERS_UNAVAILABLE' }); return; }
    // A phase that moved on while the list was made is not answered; the client asks again for the new one.
    if (gamePhaseId(room.getState()) !== phaseId) return;
    socket.emit('legal_orders', { gameId, phaseId, power: player.power,
      options: options.map(option => ({ id: option.id, unitTerritory: option.unitTerritory, order: option.order, description: option.description })) });
  });

  onClientEvent(socket, 'submit_orders', ({ gameId, ...command }) =>
    submit(gameId, { ...command, phase: 'ORDERS' }));
  onClientEvent(socket, 'submit_retreats', ({ gameId, ...command }) =>
    submit(gameId, { ...command, phase: 'RETREATS' }));
  onClientEvent(socket, 'submit_builds', ({ gameId, ...command }) =>
    submit(gameId, { ...command, phase: 'BUILDS' }));
}
