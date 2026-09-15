import type { Server, Socket } from 'socket.io';
import { onClientEvent } from './clientEvent.js';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';
import type { DiplomacyService } from '../diplomacy/DiplomacyService.js';
import { requireRoomAccess } from './authz.js';

export function attachDiplomacyHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager,
  diplomacy: DiplomacyService
): void {
  void io;

  onClientEvent(socket, 'send_diplomatic_message', async ({
    gameId,
    clientMessageId,
    toPower,
    body,
  }) => {
    const room = gameManager.getRoom(gameId.trim().toUpperCase());
    if (!room) {
      socket.emit('error', { message: 'Game not found', code: 'GAME_NOT_FOUND' });
      return;
    }
    if (!requireRoomAccess(socket, room)) return;

    const sender = room.getPlayerBySocket(socket.id);
    if (!sender) {
      socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
      return;
    }

    if (!/^[0-9a-f-]{36}$/i.test(clientMessageId)) {
      socket.emit('error', {
        message: 'Invalid message identifier',
        code: 'INVALID_MESSAGE',
      });
      return;
    }

    try {
      await diplomacy.send({
        gameId: room.gameId,
        fromPower: sender.power,
        toPower,
        body,
        messageId: clientMessageId,
        source: 'WEB',
      });
    } catch (error) {
      console.error(`Failed to generate diplomatic reply in ${room.gameId}:`, error);
      socket.emit('error', {
        message: 'The message was stored, but the automated reply failed.',
        code: 'LLM_REPLY_FAILED',
      });
    }
  });

  onClientEvent(socket, 'request_diplomacy_history', ({ gameId }) => {
    const room = gameManager.getRoom(gameId.trim().toUpperCase());
    if (!room) return;
    if (!requireRoomAccess(socket, room)) return;

    const player = room.getPlayerBySocket(socket.id);
    if (!player) return;

    socket.emit('diplomacy_history', {
      messages: room.getDiplomaticMessages(player.power),
    });
  });
}
