import { isOfflineSeatModel } from '../llm/PracticeBotController.js';
import type { Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  GameSettings,
  ServerToClientEvents,
} from '@diplomacy/shared';
import { eventPrincipal } from '../auth/socketPolicy.js';
import type { GameRoom } from '../GameRoom.js';

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export function isSocketAuthenticated(socket: AppSocket): boolean {
  return eventPrincipal() !== null;
}

export function modelRequiresAuthenticatedAi(model: string | undefined): boolean {
  return !isOfflineSeatModel(model);
}

export function settingsRequireAuthenticatedAi(settings: Partial<GameSettings>): boolean {
  if (!Object.prototype.hasOwnProperty.call(settings, 'llmNegotiationPlannerModel')) return false;
  return modelRequiresAuthenticatedAi(settings.llmNegotiationPlannerModel);
}

export function requireAuthenticatedAi(
  socket: AppSocket,
  message = 'Sign in to access this game'
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

/** Provider configuration is an operator capability, independent of room hosting. */
export function requireOperator(socket: AppSocket): boolean {
  const principal = eventPrincipal();
  if (principal?.operator) return true;
  socket.emit('error', { code: principal ? 'OPERATOR_REQUIRED' : 'AUTH_REQUIRED', message: 'Only an operator can configure AI providers.' });
  return false;
}
