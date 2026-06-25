import type { Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  GameSettings,
  ServerToClientEvents,
} from '@diplomacy/shared';
import { verifyAuthCookieHeader } from '../auth.js';
import type { GameRoom } from '../GameRoom.js';

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export function isSocketAuthenticated(socket: AppSocket): boolean {
  const authenticated = (socket.data as { authenticated?: boolean } | undefined)?.authenticated;
  if (typeof authenticated === 'boolean') return authenticated;
  const cookieHeader = (socket as unknown as {
    handshake?: { headers?: { cookie?: string } };
  }).handshake?.headers?.cookie;
  return verifyAuthCookieHeader(cookieHeader).authenticated;
}

export function modelRequiresAuthenticatedAi(model: string | undefined): boolean {
  const normalized = model?.trim().toLowerCase();
  return Boolean(normalized && normalized !== 'idle' && normalized !== 'auto-hold-v0');
}

export function settingsRequireAuthenticatedAi(settings: Partial<GameSettings>): boolean {
  if (!Object.prototype.hasOwnProperty.call(settings, 'llmNegotiationPlannerModel')) return false;
  return modelRequiresAuthenticatedAi(settings.llmNegotiationPlannerModel);
}

export function requireAuthenticatedAi(
  socket: AppSocket,
  message = 'Sign in before enabling AI features for this game'
): boolean {
  if (isSocketAuthenticated(socket)) return true;
  socket.emit('error', { message, code: 'AUTH_REQUIRED' });
  return false;
}

export function requireRoomAccess(socket: AppSocket, room: GameRoom): boolean {
  if (!room.requiresAuthenticatedAccess()) return true;
  return requireAuthenticatedAi(
    socket,
    'Sign in to access games that use AI seats'
  );
}
