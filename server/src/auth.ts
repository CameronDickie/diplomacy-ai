import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import type { RuntimeConfig } from '../../config/runtime.cjs';
import type { PlayerSession } from '@diplomacy/shared';
import { newToken, hashToken, type Store } from './storage/Store.js';
import type { StoredPlayer } from './storage/contracts.js';
import { authorizationUrl, OAuthProvider, type Credentials, type OAuthRequest, type Provider } from './auth/provider.js';

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const FLOW_TTL = 10 * 60 * 1000;
const opaque = /^[A-Za-z0-9_-]{43}$/;
interface Pending extends OAuthRequest { bindingHash: string; expiresAt: number }
export interface Principal { player: StoredPlayer; operator: boolean; expiresAt: number }
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header || header.length > 8192) return null;
  const values = header.split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  try { return decodeURIComponent(values[0].slice(name.length + 1)); } catch { return null; }
}
const equal = (a: string | null, b: string): boolean => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class AuthService {
  private readonly pending = new Map<string, Pending>();
  private readonly rates = new Map<string, { count: number; expiresAt: number }>();
  private readonly credentials: Partial<Record<Provider, Credentials>> = {};
  private exchanges = 0;
  private readonly secret: string;
  private readonly invalidation = new Set<(hash: string) => void>();
  /** A sign-in with no identity provider, for local development only. */
  private readonly devLogin: boolean;
  readonly cookieName: string;
  private readonly flowCookie: string;
  constructor(readonly store: Store, readonly config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env,
      private readonly provider = new OAuthProvider(), private readonly now = Date.now) {
    this.secret = env.DIPLOMACY_AUTH_SESSION_SECRET ?? '';
    for (const name of ['github', 'google'] as const) {
      const clientId = env[`DIPLOMACY_${name.toUpperCase()}_CLIENT_ID`];
      const clientSecret = env[`DIPLOMACY_${name.toUpperCase()}_CLIENT_SECRET`];
      if (clientId && clientSecret && this.secret.length >= 32) this.credentials[name] = { clientId, clientSecret };
    }
    this.devLogin = config.devLogin === true && config.profile === 'local' && !config.production && this.secret.length >= 32;
    this.cookieName = config.cookieSecure ? '__Host-diplomacy_session' : 'diplomacy_session';
    this.flowCookie = config.cookieSecure ? '__Host-diplomacy_oauth' : 'diplomacy_oauth';
  }
  allowsSocketRequest(headers: { origin?: string; [key: string]: string | string[] | undefined }): boolean {
    const origin = headers.origin;
    if (origin) return this.config.corsOrigins.includes(origin) || origin === this.config.callbackOrigin;
    // Browsers omit Origin on same-origin polling GETs. Fetch Metadata is a
    // forbidden browser header, so a cross-site page cannot forge this fallback.
    // WebSocket handshakes always require an explicit allowlisted Origin.
    return headers.upgrade !== 'websocket' && headers['sec-fetch-site'] === 'same-origin';
  }
  private cookieOptions() { return { httpOnly: true, sameSite: 'lax' as const, secure: this.config.cookieSecure, path: '/' }; }
  tokenHash(header: string | undefined): string | null {
    const token = readCookie(header, this.cookieName);
    return token && opaque.test(token) && this.secret.length >= 32 ? createHmac('sha256', this.secret).update(token).digest('hex') : null;
  }
  async resolve(header: string | undefined): Promise<Principal | null> {
    const tokenHash = this.tokenHash(header);
    if (!tokenHash) return null;
    const session = await this.store.call('session', { tokenHash, now: this.now() });
    return session ? { ...session, operator: session.player.provider === 'github' && this.config.admins.includes(session.player.subject) } : null;
  }
  onRevoke(listener: (hash: string) => void): () => void { this.invalidation.add(listener); return () => this.invalidation.delete(listener); }
  private async revoke(header: string | undefined): Promise<void> {
    const tokenHash = this.tokenHash(header);
    if (!tokenHash) return;
    await this.store.call('revokeSession', { tokenHash, now: this.now() });
    for (const listener of this.invalidation) listener(tokenHash);
  }
  /** Ends sessions the store has already removed or revoked: live sockets are dropped and, given a response, its cookies cleared. */
  forget(tokenHashes: readonly string[], response?: express.Response): void {
    for (const tokenHash of tokenHashes) for (const listener of this.invalidation) listener(tokenHash);
    response?.clearCookie(this.cookieName, this.cookieOptions()); response?.clearCookie(this.flowCookie, this.cookieOptions());
  }
  private allowStart(ip: string): boolean {
    const now = this.now();
    for (const [state, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(state);
    for (const [key, item] of this.rates) if (item.expiresAt <= now) this.rates.delete(key);
    if (this.pending.size >= 128 || this.rates.size >= 1024) return false;
    // Never trust forwarded-for from arbitrary peers. This deliberately applies a
    // conservative shared limit behind a proxy until a trusted proxy is configured.
    for (const [key, limit] of [['global', 30], [`ip:${ip}`, 5]] as const) {
      const rate = this.rates.get(key) ?? { count: 0, expiresAt: now + 60_000 };
      if (rate.count >= limit) return false;
      rate.count++; this.rates.set(key, rate);
    }
    return true;
  }
  readonly httpBoundary: RequestHandler = (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const origin = request.headers.origin;
    if (origin && !this.config.corsOrigins.includes(origin) && origin !== this.config.callbackOrigin) {
      response.status(403).json({ code: 'ORIGIN_DENIED', message: 'Request origin is not allowed.' }); return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin); response.vary('Origin');
      response.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); response.sendStatus(204); return;
    }
    if (!['GET', 'HEAD'].includes(request.method) && !origin) {
      response.status(403).json({ code: 'ORIGIN_REQUIRED', message: 'A trusted browser origin is required.' }); return;
    }
    next();
  };
  requirePlayer(operator = false): RequestHandler {
    return (request, response, next) => {
      void this.resolve(request.headers.cookie).then(principal => {
        if (!principal || (operator && !principal.operator)) {
          response.status(principal ? 403 : 401).json({ code: principal ? 'OPERATOR_REQUIRED' : 'AUTH_REQUIRED' }); return;
        }
        response.locals.principal = principal; next();
      }).catch(() => response.status(503).json({ code: 'AUTH_UNAVAILABLE' }));
    };
  }
  router(): express.Router {
    const router = express.Router();
    router.get('/session', (request, response) => {
      void this.resolve(request.headers.cookie).then(principal => {
        const payload: PlayerSession = {
          authenticated: !!principal, enabled: this.config.authEnabled || Object.keys(this.credentials).length > 0 || this.devLogin,
          profile: this.config.profile, operator: principal?.operator ?? false,
          user: principal ? { id: principal.player.id, displayName: principal.player.displayName, provider: principal.player.provider } : null,
          providers: Object.keys(this.credentials) as Provider[],
          ...(this.devLogin ? { devSignIn: true } : {}),
          capabilities: {
            providerSettings: !!principal?.operator && this.config.profile !== 'showcase',
            discord: !!principal?.operator && this.config.profile !== 'showcase' && this.config.discord.enabled,
            voice: !!principal?.operator && this.config.profile !== 'showcase' && this.config.discord.enabled && this.config.discord.voiceEnabled,
            games: this.config.profile !== 'showcase' || this.config.showcaseGames,
            practiceBots: this.config.profile === 'local' || (this.config.profile === 'showcase' && this.config.showcaseGames),
          },
        };
        response.json(payload);
      }).catch(() => response.status(503).json({ message: 'Sign-in is temporarily unavailable.' }));
    });
    // Development only. The route does not exist unless the configuration contract allowed it, and this
    // repeats the profile check so a hand-built config cannot mint sessions either. The subject is not a
    // numeric provider ID, so this identity can never match the operator allowlist.
    if (this.devLogin) router.post('/dev-login', (request, response) => {
      void (async () => {
        const player = await this.store.call('identity', { provider: 'github', subject: 'local-development', displayName: 'Local developer', now: this.now() });
        if (player.bannedAt !== null) { response.status(403).json({ message: 'This account is banned.' }); return; }
        await this.revoke(request.headers.cookie);
        const token = newToken(), tokenHash = this.tokenHash(`${this.cookieName}=${token}`)!, issuedAt = this.now();
        await this.store.call('createSession', { tokenHash, playerId: player.id, now: issuedAt, expiresAt: issuedAt + SESSION_TTL });
        response.cookie(this.cookieName, token, { ...this.cookieOptions(), maxAge: SESSION_TTL });
        response.sendStatus(204);
      })().catch(() => response.status(503).json({ message: 'Development sign-in is unavailable.' }));
    });
    router.post('/logout', (request, response) => {
      void this.revoke(request.headers.cookie).then(() => {
        const flow = readCookie(request.headers.cookie, this.flowCookie);
        if (flow) for (const [state, item] of this.pending) if (equal(hashToken(flow), item.bindingHash)) this.pending.delete(state);
        response.clearCookie(this.cookieName, this.cookieOptions()); response.clearCookie(this.flowCookie, this.cookieOptions());
        response.sendStatus(204);
      }).catch(() => response.status(503).json({ message: 'Sign-out could not be completed. Please retry.' }));
    });
    for (const provider of ['github', 'google'] as const) {
      router.get(`/${provider}`, (request, response) => {
        const credentials = this.credentials[provider];
        if (!credentials) { response.status(503).json({ message: 'This sign-in provider is not configured.' }); return; }
        if (request.headers['sec-fetch-site'] === 'cross-site') { response.sendStatus(403); return; }
        if (!this.allowStart(request.socket.remoteAddress ?? 'unknown')) { response.setHeader('Retry-After', '60'); response.sendStatus(429); return; }
        const state = newToken(), binding = newToken();
        const pending: Pending = { provider, verifier: newToken(), nonce: newToken(), bindingHash: hashToken(binding),
          callback: `${this.config.callbackOrigin}/api/auth/${provider}/callback`, expiresAt: this.now() + FLOW_TTL };
        // One flow per browser: a new sign-in supersedes its earlier tab.
        const previous = readCookie(request.headers.cookie, this.flowCookie);
        if (previous) for (const [key, item] of this.pending) if (equal(hashToken(previous), item.bindingHash)) this.pending.delete(key);
        this.pending.set(state, pending);
        response.cookie(this.flowCookie, binding, { ...this.cookieOptions(), maxAge: FLOW_TTL });
        response.redirect(303, authorizationUrl(pending, credentials.clientId, state));
      });
      router.get(`/${provider}/callback`, (request, response) => {
        const state = typeof request.query.state === 'string' ? request.query.state : '';
        const pending = this.pending.get(state);
        const binding = readCookie(request.headers.cookie, this.flowCookie);
        const credentials = this.credentials[provider];
        const fail = () => response.redirect(303, `${this.config.returnOrigin}/?auth=failed`);
        if (!pending || pending.provider !== provider || !credentials || !binding || !equal(hashToken(binding), pending.bindingHash)) { fail(); return; }
        this.pending.delete(state); // consume before any asynchronous provider work
        response.clearCookie(this.flowCookie, this.cookieOptions());
        if (pending.expiresAt <= this.now() || request.query.error || typeof request.query.code !== 'string' ||
            request.query.code.length < 1 || request.query.code.length > 2048 || this.exchanges >= 4) { fail(); return; }
        this.exchanges++;
        void (async () => {
          try {
            const identity = await this.provider.exchange(pending, credentials, request.query.code as string, this.now());
            const player = await this.store.call('identity', { ...identity, now: this.now() });
            if (player.bannedAt !== null) { fail(); return; }
            // Rotate any old application session; no provider token is persisted.
            await this.revoke(request.headers.cookie);
            const token = newToken();
            const tokenHash = this.tokenHash(`${this.cookieName}=${token}`)!;
            const issuedAt = this.now();
            await this.store.call('createSession', { tokenHash, playerId: player.id, now: issuedAt, expiresAt: issuedAt + SESSION_TTL });
            response.cookie(this.cookieName, token, { ...this.cookieOptions(), maxAge: SESSION_TTL });
            response.redirect(303, `${this.config.returnOrigin}/`);
          } catch { fail(); } // Do not log provider bodies, tokens, codes or URLs.
          finally { this.exchanges--; }
        })();
      });
    }
    router.use((_request, response) => { response.status(404).json({ message: 'Unknown sign-in endpoint.' }); });
    return router;
  }
}
