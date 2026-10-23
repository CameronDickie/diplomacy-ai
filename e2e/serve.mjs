// Starts the built server for browser tests: local profile, mock opponents, a temporary database,
// and test accounts created directly in that database. No real sign-in, provider call or email.
// Every credential-like value is generated per run and written only to the ignored state file.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, newToken } from '../server/dist/storage/Store.js';

const port = process.env.E2E_PORT ?? '3999', origin = `http://127.0.0.1:${port}`;
const database = join(mkdtempSync(join(tmpdir(), 'diplomacy-e2e-')), 'game.sqlite'), secret = randomBytes(32).toString('hex'), operatorId = '900000000017';
const store = await Store.open(database), now = Date.now(), cookies = {};
for (const [name, subject] of [['practice', 'e2e-practice'], ['sponsored', 'e2e-sponsored'], ['leaver', 'e2e-leaver'], ['bot', 'e2e-bot'], ['operator', operatorId]]) {
  const player = await store.call('identity', { provider: 'github', subject, displayName: `E2E ${name}`, now });
  const token = newToken();
  await store.call('createSession', { tokenHash: createHmac('sha256', secret).update(token).digest('hex'), playerId: player.id, now, expiresAt: now + 3_600_000 });
  cookies[name] = token;
}
// Synthetic funds so the mock sponsored attempt can reserve and settle.
await store.call('grantFunding', { amountNanousd: 200_000_000, authorizationRef: 'e2e-mock-grant-1', grantedBy: 'e2e', now });
await store.close();
writeFileSync(new URL('./.state.json', import.meta.url), JSON.stringify({ origin, cookieName: 'diplomacy_session', cookies }), { mode: 0o600 });
Object.assign(process.env, { NODE_ENV: 'development', DIPLOMACY_PROFILE: 'local', HOST: '127.0.0.1', PORT: port, DIPLOMACY_DATABASE_PATH: database,
  DIPLOMACY_AUTOPLAY_DATABASE: join(database, '..', 'autoplay.sqlite'), DIPLOMACY_STAND_IN_DATABASE: join(database, '..', 'stand-in.sqlite'),
  // Point at a file that does not exist so a developer's own .env is never loaded into the test server.
  DIPLOMACY_ENV_FILE: join(database, '..', 'no-env-file'), DIPLOMACY_AUTH_SESSION_SECRET: secret, DIPLOMACY_ADMIN_GITHUB_USER_IDS: operatorId,
  DIPLOMACY_AUTH_RETURN_ORIGIN: origin, DIPLOMACY_AUTH_CALLBACK_ORIGIN: origin, CORS_ORIGINS: origin, DIPLOMACY_LUNA_TRANSPORT: 'mock',
  DIPLOMACY_NOTIFY_MODE: 'outbox', DISCORD_ENABLED: 'false', DIPLOMACY_PAID_AI_ENABLED: 'false' });
await import('../server/dist/index.js');
