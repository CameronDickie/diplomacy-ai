import express from 'express';
import { existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, resolve } from 'path';
import { loadEnvFile } from 'process';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import { GameManager } from './GameManager.js';
import { attachHandlers } from './handlers/connectionHandler.js';
import { DiplomacyService } from './diplomacy/DiplomacyService.js';
import { DiscordLinkService } from './discord/DiscordLinkService.js';
import {
  DiscordBotManager,
  readDiscordBotConfig,
} from './discord/DiscordBotManager.js';
import { VoiceSessionManager } from './voice/VoiceSessionManager.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const rootEnvFile = resolve(currentDirectory, '../../.env');
if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);

const app = express();
const httpServer = createServer(app);
const configuredOrigins = process.env.CORS_ORIGINS
  ?.split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: configuredOrigins ?? ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST'],
  },
});

const gameManager = new GameManager();
const diplomacy = new DiplomacyService(gameManager);
const discordConfig = readDiscordBotConfig();
const discordLinks = new DiscordLinkService(
  gameManager,
  discordConfig?.guildId ?? null,
  new Set(
    discordConfig
      ? Object.keys(discordConfig.powerTokens) as Array<keyof typeof discordConfig.powerTokens>
      : []
  ),
  process.env.DISCORD_VOICE_ENABLED === 'true'
);
const discordBots = discordConfig
  ? new DiscordBotManager(discordConfig, gameManager, discordLinks, diplomacy)
  : null;
const voice = discordBots
  ? new VoiceSessionManager(
      gameManager,
      discordLinks,
      discordBots,
      process.env.DISCORD_VOICE_ENABLED === 'true'
    )
  : null;

app.get('/healthz', (_request, response) => {
  response.json({ ok: true });
});

const clientDirectory = resolve(currentDirectory, '../../client/dist');
if (existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory));
  app.get('*', (_request, response) => {
    response.sendFile(resolve(clientDirectory, 'index.html'));
  });
}

io.on('connection', socket => {
  attachHandlers(socket, io, gameManager, {
    diplomacy,
    discordLinks,
    discordBots,
    voice,
  });
});

const PORT = process.env.PORT ?? 3001;
httpServer.listen(PORT, () => {
  console.log(`Diplomacy server listening on port ${PORT}`);
  if (!discordBots) {
    console.log('Discord integration disabled: configure DISCORD_GUILD_ID and DISCORD_COORDINATOR_TOKEN');
    return;
  }
  void discordBots.start().catch(error => {
    console.error('Discord integration failed to start:', error);
  });
});

export { io };
