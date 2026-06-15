import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';
import type { DiscordBotManager } from '../discord/DiscordBotManager.js';
import type { DiscordLinkService } from '../discord/DiscordLinkService.js';
import type { VoiceSessionManager } from '../voice/VoiceSessionManager.js';

export function attachDiscordHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  _io: Server<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager,
  links: DiscordLinkService,
  bots: DiscordBotManager | null,
  voice: VoiceSessionManager | null
): void {
  socket.on('create_discord_guild_bind_code', ({ gameId }) => {
    withPlayer(socket, gameManager, gameId, (room, player) => {
      try {
        socket.emit('discord_guild_bind_code_created', {
          code: links.createGuildBindCode(room.gameId, player),
        });
      } catch (error) {
        emitError(socket, error, 'DISCORD_BIND_FAILED');
      }
    });
  });

  socket.on('create_discord_player_link_code', ({ gameId }) => {
    withPlayer(socket, gameManager, gameId, (room, player) => {
      try {
        socket.emit('discord_player_link_code_created', {
          code: links.createPlayerLinkCode(room.gameId, player),
        });
      } catch (error) {
        emitError(socket, error, 'DISCORD_LINK_FAILED');
      }
    });
  });

  socket.on('request_discord_link_status', ({ gameId }) => {
    withPlayer(socket, gameManager, gameId, (room, player) => {
      socket.emit('discord_link_status', {
        status: links.getStatus(room.gameId, player.id),
      });
      if (voice) {
        socket.emit('voice_session_state', {
          state: voice.getState(player.id),
        });
      }
    });
  });

  socket.on('start_voice_session', async ({ gameId, toPower }) => {
    await withPlayerAsync(socket, gameManager, gameId, async (room, player) => {
      if (!voice || !bots) throw new Error('Discord voice is not configured');
      await voice.start(room.gameId, player, toPower);
    }, 'VOICE_START_FAILED');
  });

  socket.on('begin_voice_input', async ({ gameId }) => {
    await withPlayerAsync(socket, gameManager, gameId, async (_room, player) => {
      if (!voice) throw new Error('Discord voice is not configured');
      await voice.beginInput(player.id);
    }, 'VOICE_INPUT_FAILED');
  });

  socket.on('commit_voice_input', ({ gameId }) => {
    withPlayer(socket, gameManager, gameId, (_room, player) => {
      try {
        if (!voice) throw new Error('Discord voice is not configured');
        voice.commitInput(player.id);
      } catch (error) {
        emitError(socket, error, 'VOICE_INPUT_FAILED');
      }
    });
  });

  socket.on('interrupt_voice_response', ({ gameId }) => {
    withPlayer(socket, gameManager, gameId, (_room, player) => {
      try {
        if (!voice) throw new Error('Discord voice is not configured');
        voice.interrupt(player.id);
      } catch (error) {
        emitError(socket, error, 'VOICE_INTERRUPT_FAILED');
      }
    });
  });

  socket.on('end_voice_session', async ({ gameId }) => {
    await withPlayerAsync(socket, gameManager, gameId, async (_room, player) => {
      if (!voice) throw new Error('Discord voice is not configured');
      await voice.end(player.id);
    }, 'VOICE_END_FAILED');
  });
}

function withPlayer(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager,
  gameId: string,
  action: (
    room: NonNullable<ReturnType<GameManager['getRoom']>>,
    player: NonNullable<ReturnType<NonNullable<ReturnType<GameManager['getRoom']>>['getPlayerBySocket']>>
  ) => void
): void {
  const room = gameManager.getRoom(gameId.trim().toUpperCase());
  const player = room?.getPlayerBySocket(socket.id);
  if (!room || !player) {
    socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
    return;
  }
  action(room, player);
}

async function withPlayerAsync(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameManager: GameManager,
  gameId: string,
  action: (
    room: NonNullable<ReturnType<GameManager['getRoom']>>,
    player: NonNullable<ReturnType<NonNullable<ReturnType<GameManager['getRoom']>>['getPlayerBySocket']>>
  ) => Promise<void>,
  code: string
): Promise<void> {
  const room = gameManager.getRoom(gameId.trim().toUpperCase());
  const player = room?.getPlayerBySocket(socket.id);
  if (!room || !player) {
    socket.emit('error', { message: 'Not in this game', code: 'NOT_IN_GAME' });
    return;
  }
  try {
    await action(room, player);
  } catch (error) {
    emitError(socket, error, code);
  }
}

function emitError(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  error: unknown,
  code: string
): void {
  socket.emit('error', {
    message: error instanceof Error ? error.message : 'Discord integration failed',
    code,
  });
}
