import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, PhaseSubmission, ServerToClientEvents } from '@diplomacy/shared';
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

  onClientEvent(socket, 'submit_orders', ({ gameId, ...command }) =>
    submit(gameId, { ...command, phase: 'ORDERS' }));
  onClientEvent(socket, 'submit_retreats', ({ gameId, ...command }) =>
    submit(gameId, { ...command, phase: 'RETREATS' }));
  onClientEvent(socket, 'submit_builds', ({ gameId, ...command }) =>
    submit(gameId, { ...command, phase: 'BUILDS' }));
}
