import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import { GameManager } from './GameManager.js';
import { attachHandlers } from './handlers/connectionHandler.js';

const app = express();
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST'],
  },
});

const gameManager = new GameManager();

io.on('connection', socket => {
  attachHandlers(socket, io, gameManager);
});

const PORT = process.env.PORT ?? 3001;
httpServer.listen(PORT, () => {
  console.log(`Diplomacy server listening on port ${PORT}`);
});

export { io };
