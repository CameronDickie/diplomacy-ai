import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';
import { attachGameHandlers } from './gameHandler.js';
import { attachOrderHandlers } from './orderHandler.js';
import { attachDiplomacyHandlers } from './diplomacyHandler.js';

export function attachHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager
): void {
  console.log(`Client connected: ${socket.id}`);

  attachGameHandlers(socket, io, gameManager);
  attachOrderHandlers(socket, io, gameManager);
  attachDiplomacyHandlers(socket, io, gameManager);

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    const room = gameManager.getRoomBySocket(socket.id);
    if (!room) return;

    const player = room.getPlayerBySocket(socket.id);
    if (!player) return;

    room.markDisconnected(socket.id);
    room.broadcast('player_disconnected', { power: player.power });
  });

  socket.on('request_state', () => {
    const room = gameManager.getRoomBySocket(socket.id);
    if (!room) return;
    socket.emit('game_state_sync', { gameState: room.getState() });
  });

  socket.on('request_phase_history', ({ gameId }) => {
    const room = gameManager.getRoom(gameId);
    if (!room || !room.hasSocket(socket.id)) return;
    socket.emit('phase_history', { reports: room.getPhaseHistory() });
  });
}
