import { AsyncLocalStorage } from 'node:async_hooks';
import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';
import type { AuthService, Principal } from '../auth.js';

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type Profile = 'local' | 'private' | 'showcase';
/** `games`: the showcase profile's hosted games are turned on (DIPLOMACY_SHOWCASE_GAMES). */
interface Policy { profile: Profile; games?: boolean; resolve(): Promise<Principal | null> }
const policies = new WeakMap<object, Policy>();
const context = new AsyncLocalStorage<{ principal: Principal | null; profile: Profile; practiceSeats: boolean }>();
export function bindSocketPolicy(socket: object, policy: Policy): void { policies.set(socket, policy); }
/** Anyone hosting a room may fill seats with the free offline bots: locally, and in showcase games. */
export const practiceSeatsAllowed = (): boolean => context.getStore()?.practiceSeats === true;
/** Showcase games cap how many rooms one account hosts; the other profiles only cap the total. */
export const isShowcaseEvent = (): boolean => context.getStore()?.profile === 'showcase';
export const eventPrincipal = (): Principal | null => context.getStore()?.principal ?? null;
const integrations = new Set<keyof ClientToServerEvents>([
  'create_discord_guild_bind_code', 'create_discord_player_link_code', 'request_discord_link_status',
  'start_voice_session', 'begin_voice_input', 'commit_voice_input', 'interrupt_voice_response', 'end_voice_session',
]);
export async function withSocketAccess(socket: AppSocket, event: keyof ClientToServerEvents, work: () => Promise<void> | void): Promise<void> {
  const policy = policies.get(socket);
  if (!policy) throw new Error('Socket policy is not bound');
  const principal = await policy.resolve(); // never trust handshake auth fields or a cached boolean
  const errorEvent = event === 'join_game' ? 'join_error' : event === 'resume_game' ? 'resume_error' : 'error';
  if (policy.profile === 'showcase' && !policy.games) {
    // These are legacy free-form room commands. Owned challenge commands have a
    // separate service; even an operator cannot bypass its preset/admission here.
    if (event !== 'request_state') socket.emit(errorEvent, {
      code: principal ? 'FEATURE_DISABLED' : 'AUTH_REQUIRED', message: 'Use the challenge page to play in showcase mode.',
    });
    return;
  }
  // Showcase games are for signed-in players: an account is what the per-account room cap counts.
  if (policy.profile === 'showcase' && !principal) {
    socket.emit(errorEvent, { code: 'AUTH_REQUIRED', message: 'Sign in to play a game with friends or practice bots.' }); return;
  }
  if (policy.profile === 'private' && !principal) {
    socket.emit(errorEvent, { code: 'AUTH_REQUIRED', message: 'Sign in to access private games.' }); return;
  }
  if (integrations.has(event) && !principal?.operator) {
    socket.emit(errorEvent, { code: 'OPERATOR_REQUIRED', message: 'Only an operator can use integrations.' }); return;
  }
  // Request-local context prevents concurrent events from overwriting each
  // other's resolved identity while they await storage or the rules engine.
  const practiceSeats = policy.profile === 'local' || (policy.profile === 'showcase' && policy.games === true);
  await context.run({ principal, profile: policy.profile, practiceSeats }, work);
}

export function installSocketPolicy(socket: AppSocket, auth: AuthService): void {
  const cookie = socket.handshake.headers.cookie;
  const hash = auth.tokenHash(cookie);
  bindSocketPolicy(socket, { profile: auth.config.profile, games: auth.config.showcaseGames, resolve: () => auth.resolve(cookie) });
  const remove = auth.onRevoke(revoked => { if (hash === revoked) socket.disconnect(true); });
  let expiry: NodeJS.Timeout | undefined;
  let checking = false;
  const check = async () => {
    if (checking || !socket.connected) return;
    checking = true;
    try {
      const principal = await auth.resolve(cookie);
      if (hash && !principal) socket.disconnect(true);
      if (principal && !expiry) expiry = setTimeout(() => socket.disconnect(true), Math.max(0, principal.expiresAt - Date.now()));
    } catch { socket.disconnect(true); }
    finally { checking = false; }
  };
  // Also remove passive room subscriptions after bans/revocation performed by
  // another process. Each action checks immediately; passive revocation <=15s.
  const interval = setInterval(() => { void check(); }, 15000).unref();
  socket.once('disconnect', () => { remove(); clearInterval(interval); if (expiry) clearTimeout(expiry); });
  void check();
}
