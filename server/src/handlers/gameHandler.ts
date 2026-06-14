import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';

export function attachGameHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager
): void {
  socket.on('create_game', ({ playerName }) => {
    const normalizedName = normalizePlayerName(playerName);
    if (!normalizedName) {
      socket.emit('error', { message: 'Player name must be 1-40 characters', code: 'INVALID_NAME' });
      return;
    }
    const existing = gameManager.getRoomBySocket(socket.id);
    if (existing) {
      socket.emit('error', { message: 'Already in a game', code: 'ALREADY_IN_GAME' });
      return;
    }

    const room = gameManager.createGame();
    room.setIO(io);

    const joined = room.addPlayer(socket.id, normalizedName);
    if (!joined) return;
    const { player, sessionToken } = joined;

    socket.join(room.gameId);

    socket.emit('game_created', {
      gameId: room.gameId,
      playerId: player.id,
      sessionToken,
      power: player.power,
      gameState: room.getState(),
    });
    socket.emit('diplomacy_history', { messages: room.getDiplomaticMessages(player.power) });

    console.log(`Game created: ${room.gameId} by ${normalizedName} (${player.power})`);
  });

  socket.on('join_game', ({ gameId, playerName }) => {
    const normalizedGameId = gameId.trim().toUpperCase();
    const normalizedName = normalizePlayerName(playerName);
    if (!normalizedName) {
      socket.emit('join_error', { message: 'Player name must be 1-40 characters', code: 'INVALID_NAME' });
      return;
    }
    const room = gameManager.getRoom(normalizedGameId);
    if (!room) {
      socket.emit('join_error', { message: `Game ${normalizedGameId} not found`, code: 'GAME_NOT_FOUND' });
      return;
    }
    if (room.getState().status !== 'LOBBY') {
      socket.emit('join_error', { message: 'This game has already started', code: 'GAME_ALREADY_STARTED' });
      return;
    }

    const joined = room.addPlayer(socket.id, normalizedName);
    if (!joined) {
      socket.emit('join_error', { message: 'Game is full', code: 'GAME_FULL' });
      return;
    }
    const { player, sessionToken } = joined;

    room.setIO(io);
    socket.join(normalizedGameId);

    socket.emit('game_joined', {
      gameId: normalizedGameId,
      playerId: player.id,
      sessionToken,
      power: player.power,
      gameState: room.getState(),
    });
    socket.emit('diplomacy_history', { messages: room.getDiplomaticMessages(player.power) });

    room.broadcast('player_joined', {
      player,
      allPlayers: room.getState().players,
    });

    console.log(`${normalizedName} joined game ${normalizedGameId} as ${player.power}`);
  });

  socket.on('resume_game', ({ gameId, sessionToken }) => {
    const normalizedGameId = gameId.trim().toUpperCase();
    const room = gameManager.getRoom(normalizedGameId);
    if (!room) {
      socket.emit('resume_error', { message: 'Game no longer exists on this server', code: 'GAME_NOT_FOUND' });
      return;
    }
    const player = room.resumePlayer(socket.id, sessionToken);
    if (!player) {
      socket.emit('resume_error', { message: 'The saved player session is invalid', code: 'INVALID_SESSION' });
      return;
    }
    room.setIO(io);
    socket.join(normalizedGameId);
    socket.emit('game_resumed', {
      gameId: normalizedGameId,
      playerId: player.id,
      power: player.power,
      gameState: room.getState(),
    });
    socket.emit('diplomacy_history', { messages: room.getDiplomaticMessages(player.power) });
    room.broadcast('game_state_sync', { gameState: room.getState() });
  });

  socket.on('add_llm_player', ({ gameId, name, provider, model, persona }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) {
      socket.emit('error', { message: `Game ${gameId} not found`, code: 'GAME_NOT_FOUND' });
      return;
    }

    if (!room.getPlayerBySocket(socket.id)) {
      socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
      return;
    }

    if (!room.isHost(socket.id)) {
      socket.emit('error', { message: 'Only the host can add players', code: 'HOST_REQUIRED' });
      return;
    }

    if (room.getState().status !== 'LOBBY') {
      socket.emit('error', { message: 'Cannot add players after game start', code: 'GAME_ALREADY_STARTED' });
      return;
    }

    const player = room.addLlmPlayer({ name, provider, model, persona });
    if (!player) {
      socket.emit('error', { message: 'Game is full', code: 'GAME_FULL' });
      return;
    }

    room.broadcast('player_joined', {
      player,
      allPlayers: room.getState().players,
    });
  });

  socket.on('start_game', ({ gameId }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) {
      socket.emit('error', { message: `Game ${gameId} not found`, code: 'GAME_NOT_FOUND' });
      return;
    }

    if (!room.getPlayerBySocket(socket.id)) {
      socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
      return;
    }

    if (!room.isHost(socket.id)) {
      socket.emit('error', { message: 'Only the host can start the game', code: 'HOST_REQUIRED' });
      return;
    }

    if (!room.startGame()) {
      socket.emit('error', {
        message: 'All seven powers need a human or LLM controller before starting',
        code: 'GAME_NOT_READY',
      });
      return;
    }

    room.broadcast('game_started', { gameState: room.getState() });
    room.broadcast('game_state_sync', { gameState: room.getState() });
  });
}

function normalizePlayerName(name: string): string | null {
  const normalized = name.trim();
  return normalized.length >= 1 && normalized.length <= 40 ? normalized : null;
}
