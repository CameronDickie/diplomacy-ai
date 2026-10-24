import { isIP } from 'node:net';
import type { RequestHandler, Response } from 'express';
import type { RuntimeConfig } from '../../../config/runtime.cjs';
import type { ClientToServerEvents } from '@diplomacy/shared';
import type { Principal } from '../auth.js';

export interface RateRule { limit: number; windowMs: number }
const perMinute = (limit: number): RateRule => ({ limit, windowMs: 60_000 });
/**
 * Short-window abuse limits. They sit in front of, and never replace, the durable SQLite quotas
 * (active attempts, daily starts): a restart clears these buckets but cannot refill those.
 * `identity` is the signed-in player; `address` is the supplementary network key.
 */
export const RATE_POLICY = {
  public: { address: perMinute(120) },
  read: { identity: perMinute(240), address: perMinute(600) },
  legal: { identity: perMinute(30), address: perMinute(120) },
  command: { identity: perMinute(30), address: perMinute(120) },
  start: { identity: perMinute(10), address: perMinute(30) },
  account: { identity: perMinute(5), address: perMinute(20) },
  operator: { identity: perMinute(120), address: perMinute(240) },
  room: { identity: perMinute(20), address: perMinute(60) },
} satisfies Record<string, { identity?: RateRule; address: RateRule }>;
export type RateCategory = keyof typeof RATE_POLICY;
/**
 * The same buckets for a hosted game's socket events: creating, joining and setting up a game are
 * `room`; anything that runs the rules engine is `legal`; orders and messages are `command`.
 */
export const SOCKET_RATE: Record<keyof ClientToServerEvents, Exclude<RateCategory, 'public'>> = {
  create_game: 'room', join_game: 'room', resume_game: 'room', add_llm_player: 'room', update_game_settings: 'room', start_game: 'room',
  request_legal_orders: 'legal',
  submit_orders: 'command', submit_retreats: 'command', submit_builds: 'command', send_diplomatic_message: 'command',
  request_diplomacy_history: 'read', request_phase_history: 'read', request_state: 'read', request_discord_link_status: 'read',
  create_discord_guild_bind_code: 'command', create_discord_player_link_code: 'command', start_voice_session: 'command',
  begin_voice_input: 'command', commit_voice_input: 'command', interrupt_voice_response: 'command', end_voice_session: 'command',
};

export function isPrivateAddress(address: string): boolean {
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(ip) === 6 && (ip === '::1' || /^f[cd]/i.test(ip));
}
/**
 * Forwarded-For is honoured only when the direct peer is a private-network proxy and the operator
 * opted in. The right-most entry is the one that proxy appended; anything to its left is client-supplied.
 */
export function clientAddress(request: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }, trustedProxy: RuntimeConfig['trustedProxy']): string {
  const peer = request.socket.remoteAddress ?? 'unknown';
  if (trustedProxy !== 'private' || !isPrivateAddress(peer)) return peer;
  const header = request.headers['x-forwarded-for'];
  const last = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').pop()?.trim() ?? '';
  return last.length <= 45 && isIP(last) ? last : peer;
}

export class RateLimiter {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly trustedProxy: RuntimeConfig['trustedProxy'], private readonly now: () => number = Date.now, private readonly maxKeys = 20_000) {}
  /** Returns 0 when the request may proceed, otherwise whole seconds until its window resets. */
  take(key: string, rule: RateRule): number {
    const now = this.now();
    let counter = this.counters.get(key);
    if (counter && counter.resetAt <= now) { this.counters.delete(key); counter = undefined; }
    if (!counter) {
      if (this.counters.size >= this.maxKeys) {
        for (const [k,v] of this.counters) if (v.resetAt <= now) this.counters.delete(k);
        // Memory stays bounded under a key flood; refusing new keys briefly is the safe failure.
        if (this.counters.size >= this.maxKeys) return 60;
      }
      counter = { count: 0, resetAt: now + rule.windowMs };
      this.counters.set(key, counter);
    }
    if (counter.count >= rule.limit) return Math.max(1, Math.ceil((counter.resetAt - now) / 1000));
    counter.count++;
    return 0;
  }
  private reject(response: Response, retryAfterSeconds: number): void {
    response.setHeader('Retry-After', String(retryAfterSeconds));
    response.status(429).json({ code: 'RATE_LIMITED', retryAfterSeconds, message: `Too many requests. Try again in ${retryAfterSeconds} seconds.` });
  }
  /** Runs before authentication so an unauthenticated flood is bounded too. */
  address(category: RateCategory): RequestHandler {
    return (request, response, next) => {
      const wait = this.take(`${category}:a:${clientAddress(request, this.trustedProxy)}`, RATE_POLICY[category].address);
      if (wait) this.reject(response, wait); else next();
    };
  }
  /** Runs after `requirePlayer`: the key is the account, so new connections or cookies do not reset it. */
  identity(category: Exclude<RateCategory, 'public'>): RequestHandler {
    return (_request, response, next) => {
      const wait = this.take(`${category}:p:${(response.locals.principal as Principal).player.id}`, RATE_POLICY[category].identity);
      if (wait) this.reject(response, wait); else next();
    };
  }
}
