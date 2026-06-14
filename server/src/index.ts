import express from 'express';
import { existsSync } from 'fs';
import { createServer } from 'http';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import { GameManager } from './GameManager.js';
import { attachHandlers } from './handlers/connectionHandler.js';

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

app.get('/healthz', (_request, response) => {
  response.json({ ok: true });
});

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const clientDirectory = resolve(currentDirectory, '../../client/dist');
if (existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory));
  app.get('*', (_request, response) => {
    response.sendFile(resolve(clientDirectory, 'index.html'));
  });
}

io.on('connection', socket => {
  attachHandlers(socket, io, gameManager);
});

const PORT = process.env.PORT ?? 3001;
httpServer.listen(PORT, () => {
  console.log(`Diplomacy server listening on port ${PORT}`);
});

export { io };
