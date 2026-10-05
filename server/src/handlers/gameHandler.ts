import type { Server, Socket } from 'socket.io';
import { isLocalEvent } from '../auth/socketPolicy.js';
import { onClientEvent } from './clientEvent.js';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';
import {
  requireOperator,
  requireRoomAccess,
  settingsRequireAuthenticatedAi,
} from './authz.js';

export function attachGameHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager
): void {
  onClientEvent(socket, 'create_game', ({ playerName, preferredPower }) => {
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

    const requestedPower = preferredPower ?? 'RANDOM';
    const joined = room.addPlayer(socket.id, normalizedName, requestedPower);
    if (!joined) {
      socket.emit('error', {
        message: `${requestedPower} is not available`,
        code: 'POWER_UNAVAILABLE',
      });
      return;
    }
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
    socket.emit('phase_history', { reports: room.getPhaseHistory() });

    console.log(`Game created: ${room.gameId} by ${normalizedName} (${player.power})`);
  });

  onClientEvent(socket, 'join_game', ({ gameId, playerName, preferredPower }) => {
    if (gameManager.getRoomBySocket(socket.id)) {
      socket.emit('join_error', { message: 'You already have a seat in a game.', code: 'ALREADY_IN_GAME' });
      return;
    }
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
    if (!requireRoomAccess(socket, room)) return;
    if (room.getState().status !== 'LOBBY') {
      socket.emit('join_error', { message: 'This game has already started', code: 'GAME_ALREADY_STARTED' });
      return;
    }

    const requestedPower = preferredPower ?? 'RANDOM';
    const joined = room.addPlayer(socket.id, normalizedName, requestedPower);
    if (!joined) {
      socket.emit('join_error', {
        message: room.getAvailablePowers().length === 0
          ? 'Game is full'
          : `${requestedPower} is no longer available`,
        code: room.getAvailablePowers().length === 0 ? 'GAME_FULL' : 'POWER_UNAVAILABLE',
      });
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
    socket.emit('phase_history', { reports: room.getPhaseHistory() });

    room.broadcast('player_joined', {
      player,
      allPlayers: room.getState().players,
    });

    console.log(`${normalizedName} joined game ${normalizedGameId} as ${player.power}`);
  });

  onClientEvent(socket, 'resume_game', ({ gameId, sessionToken }) => {
    const normalizedGameId = gameId.trim().toUpperCase();
    const room = gameManager.getRoom(normalizedGameId);
    if (!room) {
      socket.emit('resume_error', { message: 'Game no longer exists on this server', code: 'GAME_NOT_FOUND' });
      return;
    }
    if (!requireRoomAccess(socket, room)) return;
    const existingRoom = gameManager.getRoomBySocket(socket.id);
    if (existingRoom && existingRoom !== room) {
      socket.emit('resume_error', { message: 'You already have a seat in another game.', code: 'ALREADY_IN_GAME' });
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
    socket.emit('submission_state', room.getSubmissionState(player.power));
    socket.emit('diplomacy_history', { messages: room.getDiplomaticMessages(player.power) });
    socket.emit('phase_history', { reports: room.getPhaseHistory() });
    room.broadcast('game_state_sync', { gameState: room.getState() });
  });

  onClientEvent(socket, 'add_llm_player', ({
    gameId,
    power,
    name,
    provider,
    model,
    persona,
    realtimeModel,
    voice,
    voiceInstructions,
  }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) {
      socket.emit('error', { message: `Game ${gameId} not found`, code: 'GAME_NOT_FOUND' });
      return;
    }
    if (!requireRoomAccess(socket, room)) return;

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

    const offlineSeat = isLocalEvent() && (provider === undefined || provider === 'STUB') &&
      (model === undefined || model === 'idle' || model === 'auto-hold-v0');
    if (!offlineSeat && !requireOperator(socket)) return;

    const validation = room.validateLlmPlayerOptions({ provider, model });
    if (!validation.ok) {
      socket.emit('error', {
        message: validation.message,
        code: validation.code,
      });
      return;
    }

    const player = room.addLlmPlayer({
      power,
      name,
      provider,
      model,
      persona,
      realtimeModel,
      voice,
      voiceInstructions,
    });
    if (!player) {
      socket.emit('error', { message: 'Game is full', code: 'GAME_FULL' });
      return;
    }

    room.broadcast('player_joined', {
      player,
      allPlayers: room.getState().players,
    });
  });

  onClientEvent(socket, 'update_game_settings', ({ gameId, ...settings }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) {
      socket.emit('error', { message: `Game ${gameId} not found`, code: 'GAME_NOT_FOUND' });
      return;
    }
    if (!requireRoomAccess(socket, room)) return;
    if (!room.isHost(socket.id)) {
      socket.emit('error', { message: 'Only the host can change game settings', code: 'HOST_REQUIRED' });
      return;
    }
    if (!requireOperator(socket)) return;
    const enablesAuthenticatedAi = settingsRequireAuthenticatedAi(settings);
    if (!room.updateGameSettings(settings)) {
      socket.emit('error', {
        message: 'Invalid game settings or the game has already started',
        code: 'INVALID_GAME_SETTINGS',
      });
      return;
    }
    if (enablesAuthenticatedAi) room.enableAuthenticatedAiAccess();
    room.broadcast('game_state_sync', { gameState: room.getState() });
  });

  onClientEvent(socket, 'start_game', async ({ gameId }) => {
    const room = gameManager.getRoom(gameId);
    if (!room) {
      socket.emit('error', { message: `Game ${gameId} not found`, code: 'GAME_NOT_FOUND' });
      return;
    }

    if (!requireRoomAccess(socket, room)) return;

    if (!room.getPlayerBySocket(socket.id)) {
      socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
      return;
    }

    if (!room.isHost(socket.id)) {
      socket.emit('error', { message: 'Only the host can start the game', code: 'HOST_REQUIRED' });
      return;
    }

    try {
      if (!await room.startGame()) {
        socket.emit('error', {
          message: 'All seven powers need a human or LLM controller before starting',
          code: 'GAME_NOT_READY',
        });
        return;
      }
    } catch (error) {
      console.error(`Failed to start game ${room.gameId}:`, error);
      socket.emit('error', {
        message: 'The game could not start because phase initialization failed.',
        code: 'GAME_START_FAILED',
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
