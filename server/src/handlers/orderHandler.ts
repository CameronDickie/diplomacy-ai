import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';

export function attachOrderHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager
): void {
  void io; // io available for future use

  socket.on('submit_orders', ({ gameId, orders }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) {
      socket.emit('error', { message: 'Game not found', code: 'GAME_NOT_FOUND' });
      return;
    }

    const player = room.getPlayerBySocket(socket.id);
    if (!player) {
      socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
      return;
    }

    if (room.getState().phase !== 'ORDERS') {
      socket.emit('error', { message: 'Not in orders phase', code: 'WRONG_PHASE' });
      return;
    }

    // Acknowledge receipt
    socket.emit('orders_acknowledged', { orders });

    room.submitOrders(player.power, orders);
  });

  socket.on('submit_retreats', ({ gameId, retreats }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) return;

    const player = room.getPlayerBySocket(socket.id);
    if (!player) return;

    if (room.getState().phase !== 'RETREATS') {
      socket.emit('error', { message: 'Not in retreats phase', code: 'WRONG_PHASE' });
      return;
    }

    room.submitRetreats(player.power, retreats);
  });

  socket.on('submit_builds', ({ gameId, builds, disbands }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) return;

    const player = room.getPlayerBySocket(socket.id);
    if (!player) return;

    if (room.getState().phase !== 'BUILDS') {
      socket.emit('error', { message: 'Not in builds phase', code: 'WRONG_PHASE' });
      return;
    }

    room.submitBuilds(player.power, { gameId, builds, disbands });
  });
}
