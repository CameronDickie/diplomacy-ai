import type { Server, Socket } from 'socket.io';
import { onClientEvent } from './clientEvent.js';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';
import { attachGameHandlers } from './gameHandler.js';
import { attachOrderHandlers } from './orderHandler.js';
import { attachDiplomacyHandlers } from './diplomacyHandler.js';
import { attachDiscordHandlers } from './discordHandler.js';
import type { DiplomacyService } from '../diplomacy/DiplomacyService.js';
import type { Integrations } from '../integrations.js';
import { requireRoomAccess } from './authz.js';

export function attachHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager,
  services: {
    diplomacy: DiplomacyService;
    integrations: Integrations | null;
  }
): void {
  console.log(`Client connected: ${socket.id}`);

  attachGameHandlers(socket, io, gameManager);
  attachOrderHandlers(socket, io, gameManager);
  attachDiplomacyHandlers(socket, io, gameManager, services.diplomacy);
  if (services.integrations) {
    const { links, bots, voice } = services.integrations;
    attachDiscordHandlers(socket, io, gameManager, links, bots, voice);
  }

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    const room = gameManager.getRoomBySocket(socket.id);
    if (!room) return;

    const player = room.getPlayerBySocket(socket.id);
    if (!player) return;

    room.markDisconnected(socket.id);
    room.broadcast('player_disconnected', { power: player.power });
  });

  onClientEvent(socket, 'request_state', () => {
    const room = gameManager.getRoomBySocket(socket.id);
    if (!room) return;
    if (!requireRoomAccess(socket, room)) return;
    socket.emit('game_state_sync', { gameState: room.getState() });
    const player = room.getPlayerBySocket(socket.id);
    if (player) socket.emit('submission_state', room.getSubmissionState(player.power));
  });

  onClientEvent(socket, 'request_phase_history', ({ gameId }) => {
    const room = gameManager.getRoom(gameId);
    if (!room || !room.hasSocket(socket.id)) return;
    if (!requireRoomAccess(socket, room)) return;
    socket.emit('phase_history', { reports: room.getPhaseHistory() });
  });
}
