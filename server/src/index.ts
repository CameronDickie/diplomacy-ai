import express from 'express';
import { readRuntimeConfig, assertRuntimeReady } from '../../config/runtime.cjs';
import { existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, resolve } from 'path';
import { loadEnvFile } from 'process';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import { createAuthRouter, requireSiteAuth, verifyAuthCookieHeader } from './auth.js';
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
const rootEnvFile = process.env.DIPLOMACY_ENV_FILE ?? resolve(currentDirectory, '../../.env');
if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);

let config;
try {
  config = readRuntimeConfig();
  assertRuntimeReady(config);
} catch (error) {
  console.error(`Invalid runtime configuration: ${error instanceof Error ? error.message : 'validation failed'}`);
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: config.corsOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const gameManager = new GameManager();
const diplomacy = new DiplomacyService(gameManager);
const discordConfig = config.discord.enabled ? readDiscordBotConfig() : null;
const discordLinks = new DiscordLinkService(
  gameManager,
  discordConfig?.guildId ?? null,
  new Set(
    discordConfig
      ? Object.keys(discordConfig.powerTokens) as Array<keyof typeof discordConfig.powerTokens>
      : []
  ),
  config.discord.voiceEnabled
);
const discordBots = discordConfig
  ? new DiscordBotManager(discordConfig, gameManager, discordLinks, diplomacy)
  : null;
const voice = discordBots
  ? new VoiceSessionManager(
      gameManager,
      discordLinks,
      discordBots,
      config.discord.voiceEnabled,
      config.discord.voiceDebug,
      config.discord.autoListen
    )
  : null;

app.use(express.json());

app.get('/healthz', (_request, response) => {
  response.json({ ok: true });
});

app.use('/api/auth', createAuthRouter());
app.use('/api', requireSiteAuth);

const clientDirectory = resolve(currentDirectory, '../../client/dist');
if (existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory));
  app.get('*', (_request, response) => {
    response.sendFile(resolve(clientDirectory, 'index.html'));
  });
}

io.on('connection', socket => {
  socket.data.authenticated = verifyAuthCookieHeader(socket.handshake.headers.cookie).authenticated;
  attachHandlers(socket, io, gameManager, {
    diplomacy,
    discordLinks,
    discordBots,
    voice,
  });
});

const PORT = config.port;
httpServer.listen(PORT, config.host, () => {
  console.log(`Diplomacy server listening on port ${PORT}`);
  if (!discordBots) {
    console.log('Discord integration disabled');
    return;
  }
  void discordBots.start().catch(error => {
    console.error('Discord integration failed to start:', error);
  });
});

export { io };
