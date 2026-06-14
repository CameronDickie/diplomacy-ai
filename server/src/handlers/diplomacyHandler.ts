import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';

export function attachDiplomacyHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager
): void {
  void io;

  socket.on('send_diplomatic_message', async ({
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

    const sender = room.getPlayerBySocket(socket.id);
    if (!sender) {
      socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
      return;
    }

    const validationError = room.validateDiplomaticMessage(sender.power, toPower, body);
    if (validationError) {
      socket.emit('error', { message: validationError, code: 'INVALID_MESSAGE' });
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
      await room.sendDiplomaticMessage(
        sender.power,
        toPower,
        body,
        clientMessageId
      );
    } catch (error) {
      console.error(`Failed to generate diplomatic reply in ${room.gameId}:`, error);
      socket.emit('error', {
        message: 'The message was stored, but the automated reply failed.',
        code: 'LLM_REPLY_FAILED',
      });
    }
  });

  socket.on('request_diplomacy_history', ({ gameId }) => {
    const room = gameManager.getRoom(gameId.trim().toUpperCase());
    if (!room) return;

    const player = room.getPlayerBySocket(socket.id);
    if (!player) return;

    socket.emit('diplomacy_history', {
      messages: room.getDiplomaticMessages(player.power),
    });
  });
}
