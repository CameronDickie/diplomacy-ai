import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { AuthService, readCookie } from '../auth.js';
import { OAuthProvider, boundedFetch, type Fetch } from '../auth/provider.js';
import { Store } from '../storage/Store.js';
import { installSocketPolicy, bindSocketPolicy, eventPrincipal, practiceSeatsAllowed } from '../auth/socketPolicy.js';
import { onClientEvent } from '../handlers/clientEvent.js';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';

function socketOnce(socket: ClientSocket, event: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const handler = (...args: unknown[]) => { clearTimeout(timer); resolve(args); };
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out waiting for ${event}`)); }, 3000);
    socket.once(event, handler);
  });
}

const env = {
  DIPLOMACY_PROFILE: 'private', DIPLOMACY_AUTH_SESSION_SECRET: 'test-session-secret-'.repeat(3),
  DIPLOMACY_GITHUB_CLIENT_ID: 'github-client', DIPLOMACY_GITHUB_CLIENT_SECRET: 'github-secret',
  DIPLOMACY_GOOGLE_CLIENT_ID: 'google-client', DIPLOMACY_GOOGLE_CLIENT_SECRET: 'google-secret',
  DIPLOMACY_ADMIN_GITHUB_USER_IDS: '22545470',
};
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
interface FixtureOptions { environment?: NodeJS.ProcessEnv; fetcher?: Fetch }
async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'diplomacy-auth-'));
  const path = join(dir, 'auth.sqlite');
  const store = await Store.open(path);
  const configEnv = options.environment ?? env;
  const config = readRuntimeConfig(configEnv);
  let now = Date.now();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let googleNonce = '';
  let githubId = 22545470;
  let claims: Record<string, unknown> = {};
  const fetcher: Fetch = options.fetcher ?? (async (url, init = {}) => {
    const address = String(url); calls.push({ url: address, init });
    assert.equal(init.redirect, 'error');
    if (address === 'https://github.com/login/oauth/access_token') return json({ access_token: 'private-provider-token', token_type: 'bearer' });
    if (address === 'https://api.github.com/user') return json({ id: githubId, login: 'Owner', email: 'same-email@example.test' });
    if (address === 'https://oauth2.googleapis.com/token') {
      const token = await new SignJWT({ nonce: googleNonce, name: 'Player', email: 'same-email@example.test', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setSubject(String(githubId))
        .setAudience('google-client').setIssuer('https://accounts.google.com')
        .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 3600).sign(privateKey);
      return json({ id_token: token });
    }
    if (address === 'https://www.googleapis.com/oauth2/v3/certs') return json({ keys: [jwk] });
    throw new Error('Unexpected provider endpoint');
  });
  const auth = new AuthService(store, config, configEnv, new OAuthProvider(fetcher), () => now);
  const app = express(); app.use('/api', auth.httpBoundary); app.use('/api/auth', auth.router());
  app.post('/api/owned', auth.requirePlayer(), (_req, res) => res.json({ playerId: res.locals.principal.player.id }));
  app.post('/api/admin', auth.requirePlayer(true), (_req, res) => res.sendStatus(204));
  const server = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    allowRequest: (req, done) => done(null, auth.allowsSocketRequest(req.headers)),
  });
  const seen: Array<boolean> = [];
  io.on('connection', socket => {
    installSocketPolicy(socket, auth);
    onClientEvent(socket, 'request_state', () => {
      seen.push(eventPrincipal()?.operator ?? false);
      socket.emit('error', { code: eventPrincipal()?.operator ? 'TEST_OPERATOR' : 'TEST_PLAYER', message: 'Observed capability' });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise<void>(resolve => io.close(() => resolve())); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (route: string, cookie = '', init: RequestInit = {}) => fetch(`${url}${route}`, {
    ...init, redirect: 'manual', headers: { Cookie: cookie, ...init.headers },
  });
  const start = async (provider: 'github' | 'google', cookie = '') => {
    const response = await request(`/api/auth/${provider}?returnTo=https://evil.test`, cookie);
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get('location')!);
    const flowCookie = response.headers.getSetCookie()[0].split(';')[0];
    googleNonce = location.searchParams.get('nonce') ?? '';
    return { location, cookie: flowCookie, state: location.searchParams.get('state')!, provider };
  };
  const finish = async (flow: Awaited<ReturnType<typeof start>>, cookie = flow.cookie) =>
    request(`/api/auth/${flow.provider}/callback?code=authorization-code&state=${flow.state}`, cookie);
  const login = async (provider: 'github' | 'google' = 'github', old = '') => {
    const flow = await start(provider, old);
    const response = await finish(flow, `${flow.cookie}; ${old}`);
    assert.equal(response.headers.get('location'), `${config.returnOrigin}/`);
    const cookie = response.headers.getSetCookie().find(c => c.startsWith(`${auth.cookieName}=`))!.split(';')[0];
    return { cookie, response, flow };
  };
  return { store, path, auth, config, calls, url, request, start, finish, login, seen,
    advance: (ms: number) => { now += ms; },
    setClaims: (value: Record<string, unknown>) => { claims = value; },
    setGithubId: (id: number) => { githubId = id; },
  };
}

test('anonymous local mode is never authenticated and missing providers have no bypass', async t => {
  const f = await fixture(t, { environment: { DIPLOMACY_PROFILE: 'local' } });
  const result = await (await f.request('/api/auth/session')).json();
  assert.deepEqual(result, { authenticated: false, enabled: false, profile: 'local', user: null, operator: false, providers: [], capabilities: { providerSettings: false, discord: false, voice: false, games: true, practiceBots: true } });
  assert.equal((await f.request('/api/auth/github')).status, 503);
  assert.equal((await f.request('/api/owned', '', { method: 'POST', headers: { Origin: f.config.returnOrigin } })).status, 401);
  assert.equal((await f.request('/api/auth/login', '', { method: 'POST', headers: { Origin: f.config.returnOrigin } })).status, 404);
});

test('GitHub login binds state and S256 PKCE to a browser, pins redirects, and stores no raw credentials', async t => {
  const f = await fixture(t);
  const flow = await f.start('github');
  assert.equal(flow.location.origin, 'https://github.com');
  assert.equal(flow.location.searchParams.get('scope'), 'read:user');
  assert.equal(flow.location.searchParams.get('redirect_uri'), 'http://localhost:3001/api/auth/github/callback');
  assert.equal(flow.location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await f.finish(flow, '')).headers.get('location'), `${f.config.returnOrigin}/?auth=failed`);
  assert.equal(f.calls.length, 0, 'wrong browser cannot exchange or consume the legitimate state');
  const response = await f.finish(flow);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `${f.config.returnOrigin}/`);
  const cookie = response.headers.getSetCookie().find(c => c.startsWith('diplomacy_session='))!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Path=\//);
  assert.equal(cookie.includes('Domain='), false);
  const body = f.calls[0].init.body as URLSearchParams;
  assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), flow.location.searchParams.get('code_challenge'));
  assert.equal(body.get('redirect_uri'), flow.location.searchParams.get('redirect_uri'));
  assert.equal(f.calls[1].init.headers && (f.calls[1].init.headers as Record<string,string>).Authorization, 'Bearer private-provider-token');
  const session = await (await f.request('/api/auth/session', cookie.split(';')[0])).json();
  assert.equal(session.authenticated, true); assert.equal(session.operator, true); assert.equal(session.user.provider, 'github');
  assert.deepEqual(session.capabilities, { providerSettings: true, discord: false, voice: false, games: true, practiceBots: false });
  assert.equal(JSON.stringify(session).includes('22545470'), false);
  assert.equal((await f.finish(flow)).headers.get('location'), `${f.config.returnOrigin}/?auth=failed`);
  assert.equal(f.calls.length, 2, 'state is one-time');
  const backup = `${f.path}.backup`; await f.store.call('backup', { destination: backup });
  const contents = (await readFile(backup)).toString();
  for (const secret of ['private-provider-token', 'authorization-code', 'github-secret', 'same-email@example.test', cookie.split(';')[0].split('=')[1]]) assert.equal(contents.includes(secret), false);
});

test('Google verifies signed ID tokens, separates identical subjects/emails, and cannot gain GitHub operator role', async t => {
  const f = await fixture(t);
  const github = await f.login();
  const google = await f.login('google');
  const g = await f.auth.resolve(github.cookie), other = await f.auth.resolve(google.cookie);
  assert.ok(g && other); assert.notEqual(g.player.id, other.player.id);
  assert.equal(other.operator, false); assert.equal(other.player.provider, 'google');
  assert.deepEqual((await (await f.request('/api/auth/session', google.cookie)).json()).capabilities, { providerSettings: false, discord: false, voice: false, games: true, practiceBots: false });
  assert.equal(google.flow.location.searchParams.get('scope'), 'openid profile email');
  assert.equal(google.flow.location.searchParams.get('access_type'), 'online');
  const denied = await f.request('/api/admin', google.cookie, { method: 'POST', headers: { Origin: f.config.returnOrigin } });
  assert.equal(denied.status, 403);
});

test('Google rejects wrong nonce and authorized presenter without creating a session', async t => {
  const f = await fixture(t);
  for (const claims of [{ nonce: 'wrong' }, { azp: 'other-client' }]) {
    f.setClaims(claims);
    const response = await f.finish(await f.start('google'));
    assert.equal(response.headers.get('location'), `${f.config.returnOrigin}/?auth=failed`);
    assert.equal(response.headers.getSetCookie().some(c => c.startsWith('diplomacy_session=')), false);
  }
});

test('Google rejects invalid signature, issuer, audience, expiry and missing claims', async () => {
  const alien = await generateKeyPair('RS256');
  const now = Date.now(), base = { iss: 'https://accounts.google.com', aud: 'client', sub: 'person', nonce: 'nonce', iat: Math.floor(now/1000), exp: Math.floor(now/1000)+100 };
  for (const change of [{ iss: 'https://evil.test' }, { aud: 'other' }, { exp: 1 }, { sub: undefined }, { nonce: undefined }, { iat: Math.floor(now/1000)+60 }, { badKey: true }]) {
    const claims = { ...base, ...change };
    const jwt = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign('badKey' in change ? alien.privateKey : privateKey);
    const provider = new OAuthProvider(async url => String(url).includes('/certs') ? json({ keys: [jwk] }) : json({ id_token: jwt }));
    await assert.rejects(provider.exchange({ provider: 'google', nonce: 'nonce', verifier: 'verifier', callback: 'http://localhost:3001/api/auth/google/callback' }, { clientId: 'client', clientSecret: 'secret' }, 'code', now));
  }
});

test('expired and provider-mismatched states, denial and callback replay never exchange codes', async t => {
  const f = await fixture(t);
  const flow = await f.start('github');
  assert.match((await f.request(`/api/auth/google/callback?code=c&state=${flow.state}`, flow.cookie)).headers.get('location')!, /auth=failed/);
  f.advance(10 * 60 * 1000);
  assert.match((await f.finish(flow)).headers.get('location')!, /auth=failed/);
  const deny = await f.start('github');
  assert.match((await f.request(`/api/auth/github/callback?error=access_denied&state=${deny.state}`, deny.cookie)).headers.get('location')!, /auth=failed/);
  assert.match((await f.finish(deny)).headers.get('location')!, /auth=failed/);
  assert.equal(f.calls.length, 0);
});

test('session rotation, logout, expiry and ban are durable and fail closed', async t => {
  const f = await fixture(t);
  const first = await f.login(), second = await f.login('github', first.cookie);
  assert.equal(await f.auth.resolve(first.cookie), null);
  const principal = await f.auth.resolve(second.cookie); assert.ok(principal);
  const reopened = await Store.open(f.path);
  try {
    const auth = new AuthService(reopened, f.config, env);
    assert.equal((await auth.resolve(second.cookie))?.player.id, principal.player.id);
    assert.equal((await f.request('/api/auth/logout', second.cookie, { method: 'POST', headers: { Origin: f.config.returnOrigin } })).status, 204);
    assert.equal(await auth.resolve(second.cookie), null);
  } finally { await reopened.close(); }
  const third = await f.login(); f.advance(7*24*60*60*1000);
  assert.equal(await f.auth.resolve(third.cookie), null);
  const fourth = await f.login(); const current = await f.auth.resolve(fourth.cookie); assert.ok(current);
  await f.store.call('banPlayer', { playerId: current.player.id, now: Date.now(), banned: true });
  assert.equal(await f.auth.resolve(fourth.cookie), null);
  assert.match((await f.finish(await f.start('github'))).headers.get('location')!, /auth=failed/);
});

test('origins are checked for HTTP mutations and raw WebSocket upgrades', async t => {
  const f = await fixture(t); const login = await f.login();
  for (const origin of [undefined, 'https://evil.test', 'null']) {
    const headers = origin ? { Origin: origin } : undefined;
    assert.equal((await f.request('/api/auth/logout', login.cookie, { method: 'POST', headers })).status, 403);
    assert.ok(await f.auth.resolve(login.cookie));
  }
  assert.equal((await f.request('/api/admin', login.cookie, { method: 'POST', headers: { Origin: f.config.returnOrigin } })).status, 204);
  assert.equal(f.auth.allowsSocketRequest({ 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(f.auth.allowsSocketRequest({}), false);
  assert.equal(f.auth.allowsSocketRequest({ upgrade: 'websocket', 'sec-fetch-site': 'same-origin' }), false);
  const polling = await f.request('/socket.io/?EIO=4&transport=polling', '', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(polling.status, 200);
  assert.match(await polling.text(), /^0/);
  const socket = connect(f.url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://evil.test', Cookie: login.cookie } });
  t.after(() => socket.close());
  await socketOnce(socket, 'connect_error'); assert.equal(socket.connected, false);
});

test('an existing socket loses revoked or expired privileges; cached socket auth cannot elevate', async t => {
  const f = await fixture(t), login = await f.login();
  const socket: ClientSocket<ServerToClientEvents, ClientToServerEvents> = connect(f.url, {
    transports: ['websocket'], reconnection: false, extraHeaders: { Origin: f.config.returnOrigin, Cookie: login.cookie }, auth: { authenticated: true, operator: true },
  });
  t.after(() => socket.close()); await socketOnce(socket, 'connect');
  let reply = socketOnce(socket, 'error'); socket.emit('request_state'); assert.equal((await reply)[0].code, 'TEST_OPERATOR');
  // Revoke directly in SQLite so no in-memory logout event can help the guard.
  await f.store.call('revokeSession', { tokenHash: f.auth.tokenHash(login.cookie)!, now: Date.now() });
  reply = socketOnce(socket, 'error'); socket.emit('request_state'); assert.equal((await reply)[0].code, 'AUTH_REQUIRED');
  assert.deepEqual(f.seen, [true]);
  const second = await f.login(); const next = connect(f.url, {
    transports: ['websocket'], reconnection: false, extraHeaders: { Origin: f.config.returnOrigin, Cookie: second.cookie },
  });
  t.after(() => next.close()); await socketOnce(next, 'connect');
  f.advance(7*24*60*60*1000);
  reply = socketOnce(next, 'error'); next.emit('request_state'); assert.equal((await reply)[0].code, 'AUTH_REQUIRED');
});

test('logout disconnects passive socket subscriptions immediately', async t => {
  const f = await fixture(t), login = await f.login();
  const socket = connect(f.url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: f.config.returnOrigin, Cookie: login.cookie } });
  t.after(() => socket.close()); await socketOnce(socket, 'connect');
  const disconnected = socketOnce(socket, 'disconnect');
  await f.request('/api/auth/logout', login.cookie, { method: 'POST', headers: { Origin: f.config.returnOrigin } });
  await disconnected; assert.equal(socket.connected, false);
});

test('showcase denies legacy commands even to an operator and ignores client-supplied authority', async t => {
  const f = await fixture(t, { environment: { ...env, DIPLOMACY_PROFILE: 'showcase' } });
  for (const cookie of ['', (await f.login()).cookie]) {
    assert.deepEqual((await (await f.request('/api/auth/session', cookie)).json()).capabilities, { providerSettings: false, discord: false, voice: false, games: false, practiceBots: false });
    let listener: ((payload: unknown) => Promise<void>) | undefined;
    const errors: Array<{ code: string }> = [];
    const fake = { data: { authenticated: true, operator: true }, on: (_event: string, fn: typeof listener) => { listener = fn; }, emit: (_event: string, error: { code: string }) => errors.push(error) };
    bindSocketPolicy(fake, { profile: 'showcase', resolve: () => f.auth.resolve(cookie) });
    let invoked = false;
    onClientEvent(fake as never, 'create_game', () => { invoked = true; });
    await listener!({ playerName: 'Owner' });
    assert.equal(invoked, false); assert.equal(errors[0].code, cookie ? 'FEATURE_DISABLED' : 'AUTH_REQUIRED');
  }
});

test('showcase games, once the owner turns them on, admit signed-in players with free seats only', async t => {
  const f = await fixture(t, { environment: { ...env, DIPLOMACY_PROFILE: 'showcase', DIPLOMACY_SHOWCASE_GAMES: 'true' } });
  const { cookie } = await f.login();
  assert.deepEqual((await (await f.request('/api/auth/session', cookie)).json()).capabilities, { providerSettings: false, discord: false, voice: false, games: true, practiceBots: true });
  for (const signedIn of [false, true]) {
    let listener: ((payload: unknown) => Promise<void>) | undefined;
    const errors: Array<{ code: string }> = [];
    const fake = { on: (_event: string, fn: typeof listener) => { listener = fn; }, emit: (_event: string, error: { code: string }) => errors.push(error) };
    bindSocketPolicy(fake, { profile: 'showcase', games: true, resolve: () => f.auth.resolve(signedIn ? cookie : '') });
    let seats: boolean | undefined;
    onClientEvent(fake as never, 'create_game', () => { seats = practiceSeatsAllowed(); });
    await listener!({ playerName: 'Player' });
    if (signedIn) { assert.equal(seats, true); assert.deepEqual(errors, []); } else { assert.equal(seats, undefined); assert.equal(errors[0].code, 'AUTH_REQUIRED'); }
  }
  assert.throws(() => readRuntimeConfig({ ...env, DIPLOMACY_SHOWCASE_GAMES: 'true' }), /DIPLOMACY_SHOWCASE_GAMES/);
});

test('cookie parsing and login rate limits reject malformed and excessive requests', async t => {
  const f = await fixture(t);
  for (const value of ['%', '%E0%A4%A', 'payload.signature', 'é'.repeat(43)]) assert.equal(await f.auth.resolve(`diplomacy_session=${value}`), null);
  assert.equal(readCookie('diplomacy_session=a; diplomacy_session=b', 'diplomacy_session'), null);
  for (let i = 0; i < 5; i++) await f.start('github');
  const rejected = await f.request('/api/auth/github'); assert.equal(rejected.status, 429); assert.equal(rejected.headers.get('retry-after'), '60');
  f.advance(60000); assert.equal((await f.request('/api/auth/github')).status, 303);
});

test('provider responses are bounded and failures reveal no provider details', async t => {
  const f = await fixture(t, { fetcher: async () => json({ error: 'SECRET-provider-debug', access_token: 'SECRET-token' }) });
  const response = await f.finish(await f.start('github'));
  assert.match(response.headers.get('location')!, /auth=failed/);
  assert.equal((await response.text()).includes('SECRET'), false);
  await assert.rejects(boundedFetch(async () => new Response('x'.repeat(65537)), 'https://example.test', {}), /too large/);
  const server = createServer((_req, _res) => { /* stall headers until the caller's deadline */ });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try { await assert.rejects(boundedFetch(fetch, `http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(30) })); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('private integration capabilities require explicit enablement and operator identity', async t => {
  const f = await fixture(t, { environment: { ...env, DISCORD_ENABLED: 'true', DISCORD_GUILD_ID: 'synthetic', DISCORD_COORDINATOR_TOKEN: 'synthetic' } });
  const owner = await f.login();
  const session = await (await f.request('/api/auth/session', owner.cookie)).json();
  assert.deepEqual(session.capabilities, { providerSettings: true, discord: true, voice: false, games: true, practiceBots: false });
  assert.equal(JSON.stringify(session).includes('synthetic'), false);
  const player = await f.login('google');
  assert.deepEqual((await (await f.request('/api/auth/session', player.cookie)).json()).capabilities, { providerSettings: false, discord: false, voice: false, games: true, practiceBots: false });
});
