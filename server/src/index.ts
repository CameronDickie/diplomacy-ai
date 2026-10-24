import express, { type ErrorRequestHandler } from 'express';
import { readRuntimeConfig } from '../../config/runtime.cjs';
import { shutdownGodip } from './adjudication/GodipAdjudicator.js';
import { Store } from './storage/Store.js';
import { existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, resolve } from 'path';
import { loadEnvFile } from 'process';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import { AuthService } from './auth.js';
import { ChallengeService } from './challenge/ChallengeService.js';
import { OperatorService } from './operator/OperatorService.js';
import { ExhibitionService } from './exhibition/ExhibitionService.js';
import { installSocketPolicy } from './auth/socketPolicy.js';
import { RateLimiter } from './limits/RateLimiter.js';
import { GameManager } from './GameManager.js';
import { attachHandlers } from './handlers/connectionHandler.js';
import { DiplomacyService } from './diplomacy/DiplomacyService.js';
import { createIntegrations } from './integrations.js';
import { FullGameService, fullGamesEnabled } from './autoplay/FullGameService.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const rootEnvFile = process.env.DIPLOMACY_ENV_FILE ?? resolve(currentDirectory, '../../.env');
if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);

let config;
try {
  config = readRuntimeConfig();
} catch (error) {
  console.error(`Invalid runtime configuration: ${error instanceof Error ? error.message : 'validation failed'}`);
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);
let store: Store;
try {
  store = await Store.open(resolve(currentDirectory, '../..', config.databasePath));
  const recoverable = await store.call('activeAttempts', {});
  console.log(`Persistent storage ready; ${recoverable.length} active challenge attempts available for recovery.`);
} catch {
  console.error('Persistent storage startup failed. Check the database path, permissions and migration compatibility.');
  process.exit(1);
}

const auth = new AuthService(store, config);
let challenges: ChallengeService;
try { challenges = await ChallengeService.open(store,config); }
catch { console.error('Challenge startup failed. Check stored definitions and rules engine availability.'); await store.close(); process.exit(1); }
const operator = new OperatorService(store, config, challenges.attempts);
operator.notifier.start();
const exhibitions = new ExhibitionService(store, config);
exhibitions.runner.start();

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  allowRequest: (request, done) => {
    done(null, auth.allowsSocketRequest(request.headers));
  },
  cors: {
    origin: config.corsOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const gameManager = new GameManager({}, { maxRooms: config.maxRooms, maxRoomsPerAccount: config.maxRoomsPerAccount });
const diplomacy = new DiplomacyService(gameManager);
const integrations = await createIntegrations(config, gameManager, diplomacy);

app.use(express.json({ limit: '64kb' }));

app.get('/healthz', async (_request, response) => {
  try {
    await store.call('health', {});
    response.json({ ok: true });
  } catch { response.status(503).json({ ok: false, code: 'STORAGE_UNAVAILABLE' }); }
});

app.use('/api', auth.httpBoundary);
app.use('/api/auth', auth.router());
app.use('/api', exhibitions.router(auth));
app.use('/api/operator', operator.router(auth));
app.use('/api', challenges.router(auth));
// Model-only full games, played and watched from the browser: local development only. They use the
// autoplay ledger (data/autoplay.sqlite by default), never this server's own database.
const fullGames = fullGamesEnabled(config)
  ? new FullGameService(resolve(currentDirectory, '../..', process.env.DIPLOMACY_AUTOPLAY_DATABASE ?? 'data/autoplay.sqlite'),
    resolve(currentDirectory, '../..', process.env.DIPLOMACY_STAND_IN_DATABASE ?? 'data/autoplay-stand-in.sqlite')) : null;
if (fullGames) app.use('/api/full-games', fullGames.router());
// Never let unknown API URLs fall through to the SPA's index page.
app.use('/api', (_request, response) => { response.status(404).json({ code: 'NOT_FOUND' }); });

const safeHttpError: ErrorRequestHandler = (_error, _request, response, _next) => {
  response.status(400).json({ code: 'INVALID_REQUEST', message: 'The request could not be parsed.' });
};
app.use(safeHttpError);

// Recorded AI games the owner published (`npm run records -- publish`), read-only. Nothing is served
// unless DIPLOMACY_PUBLISHED_GAMES_DIR names the folder; only flat `.json` names are read from it.
const publishedGames = config.publishedGamesDir ? resolve(currentDirectory, '../..', config.publishedGamesDir) : null;
app.get('/game-records/:name', (request, response) => {
  const name = request.params.name, path = publishedGames && resolve(publishedGames, name);
  if (!path || !/^[a-z0-9][a-z0-9-]{0,60}\.json$/.test(name) || !existsSync(path)) { response.status(404).json({ code: 'NOT_FOUND' }); return; }
  response.setHeader('Cache-Control', 'public, max-age=300');
  response.sendFile(path);
});
app.use('/game-records', (_request, response) => { response.status(404).json({ code: 'NOT_FOUND' }); });

const clientDirectory = resolve(currentDirectory, '../../client/dist');
if (existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory));
  app.get('*', (_request, response) => {
    response.sendFile(resolve(clientDirectory, 'index.html'));
  });
}

// One set of buckets for every connection, so reconnecting does not reset them.
const socketLimits = new RateLimiter(config.trustedProxy);
io.on('connection', socket => {
  installSocketPolicy(socket, auth, socketLimits);
  attachHandlers(socket, io, gameManager, {
    diplomacy,
    integrations,
  });
});

const PORT = config.port;
httpServer.listen(PORT, config.host, () => {
  console.log(`Diplomacy server listening on port ${PORT}`);
  if (!integrations) {
    console.log('Discord integration disabled');
    return;
  }
  void integrations.bots.start().catch(() => {
    console.error('Discord integration failed to start. Check the private integration configuration.');
  });
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Bound shutdown even if an optional integration cannot close its connection.
  setTimeout(() => process.exit(1), 10_000).unref();
  const socketsClosed = new Promise<void>(resolve => io.close(() => resolve()));
  for (const room of gameManager.getRooms()) room.dispose();
  try {
    await exhibitions.close();
    await operator.close();
    await challenges.close();
    await fullGames?.close();
    await Promise.all([shutdownGodip(), integrations?.bots.stop(), socketsClosed, store.close()]);
    // Close any remaining private-profile voice connections without starting
    // reconciliation/provider work during shutdown.
    process.exit(0);
  } catch {
    console.error('Server shutdown could not complete cleanly.');
    process.exit(1);
  }
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });

export { io };
