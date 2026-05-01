import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';

export function attachGameHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager
): void {
  socket.on('create_game', ({ playerName }) => {
    const existing = gameManager.getRoomBySocket(socket.id);
    if (existing) {
      socket.emit('error', { message: 'Already in a game', code: 'ALREADY_IN_GAME' });
      return;
    }

    const room = gameManager.createGame(socket.id, playerName);
    room.setIO(io);

    const player = room.getPlayerBySocket(socket.id);
    if (!player) return;

    socket.join(room.gameId);

    socket.emit('game_created', {
      gameId: room.gameId,
      power: player.power,
      gameState: room.getState(),
    });

    console.log(`Game created: ${room.gameId} by ${playerName} (${player.power})`);
  });

  socket.on('join_game', ({ gameId, playerName }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) {
      socket.emit('join_error', { message: `Game ${gameId} not found`, code: 'GAME_NOT_FOUND' });
      return;
    }

    const player = room.addPlayer(socket.id, playerName);
    if (!player) {
      socket.emit('join_error', { message: 'Game is full', code: 'GAME_FULL' });
      return;
    }

    room.setIO(io);
    socket.join(gameId);

    // Tell the joining player their assignment
    socket.emit('game_joined', {
      power: player.power,
      gameState: room.getState(),
    });

    // Tell everyone else who just joined
    room.broadcast('player_joined', {
      player,
      allPlayers: room.getState().players,
    });

    console.log(`${playerName} joined game ${gameId} as ${player.power}`);
  });
}
