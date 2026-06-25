import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';
import { requireRoomAccess } from './authz.js';

export function attachOrderHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager
): void {
  void io; // io available for future use

  socket.on('submit_orders', async ({ gameId, orders }) => {
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

    if (room.getState().status !== 'IN_PROGRESS') {
      socket.emit('error', { message: 'Game has not started', code: 'GAME_NOT_STARTED' });
      return;
    }

    if (room.getState().phase !== 'ORDERS') {
      socket.emit('error', { message: 'Not in orders phase', code: 'WRONG_PHASE' });
      return;
    }

    const validationError = room.validateOrders(player.power, orders);
    if (validationError) {
      socket.emit('error', { message: validationError, code: 'INVALID_ORDERS' });
      return;
    }

    try {
      await room.submitOrders(player.power, orders);
      socket.emit('orders_acknowledged', { orders });
    } catch (error) {
      console.error(`Failed to adjudicate game ${room.gameId}:`, error);
      socket.emit('error', {
        message: 'Turn resolution failed. Your submission was not finalized; please retry.',
        code: 'ADJUDICATION_FAILED',
      });
    }
  });

  socket.on('submit_retreats', async ({ gameId, retreats }) => {
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

    if (room.getState().status !== 'IN_PROGRESS') {
      socket.emit('error', { message: 'Game has not started', code: 'GAME_NOT_STARTED' });
      return;
    }

    if (room.getState().phase !== 'RETREATS') {
      socket.emit('error', { message: 'Not in retreats phase', code: 'WRONG_PHASE' });
      return;
    }

    const validationError = room.validateRetreats(player.power, retreats);
    if (validationError) {
      socket.emit('error', { message: validationError, code: 'INVALID_RETREATS' });
      return;
    }

    try {
      await room.submitRetreats(player.power, retreats);
    } catch (error) {
      console.error(`Failed to resolve retreats in ${room.gameId}:`, error);
      socket.emit('error', {
        message: 'Retreat resolution failed. Please retry.',
        code: 'ADJUDICATION_FAILED',
      });
    }
  });

  socket.on('submit_builds', async ({ gameId, builds, disbands }) => {
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

    if (room.getState().status !== 'IN_PROGRESS') {
      socket.emit('error', { message: 'Game has not started', code: 'GAME_NOT_STARTED' });
      return;
    }

    if (room.getState().phase !== 'BUILDS') {
      socket.emit('error', { message: 'Not in builds phase', code: 'WRONG_PHASE' });
      return;
    }

    const payload = { gameId, builds, disbands };
    const validationError = room.validateBuilds(player.power, payload);
    if (validationError) {
      socket.emit('error', { message: validationError, code: 'INVALID_BUILDS' });
      return;
    }

    try {
      await room.submitBuilds(player.power, payload);
    } catch (error) {
      console.error(`Failed to resolve builds in ${room.gameId}:`, error);
      socket.emit('error', {
        message: 'Build resolution failed. Please retry.',
        code: 'ADJUDICATION_FAILED',
      });
    }
  });
}
