import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAuthCookieHeader } from '../auth.js';

test('malformed percent escapes and multibyte signatures cannot throw during socket authentication', () => {
  const settings = {
    DIPLOMACY_AUTH_ENABLED: 'true',
    DIPLOMACY_AUTH_USERNAME: 'test-user',
    DIPLOMACY_AUTH_PASSWORD_SALT: 'test-salt',
    DIPLOMACY_AUTH_PASSWORD_HASH: 'test-hash',
    DIPLOMACY_AUTH_SESSION_SECRET: 'test-only-session-secret',
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    for (const value of ['%', '%E0%A4%A', `payload.${'é'.repeat(43)}`, 'payload.invalid']) {
      const state = verifyAuthCookieHeader(`diplomacy_session=${value}`);
      assert.equal(state.authenticated, false);
      assert.equal(state.status, 401);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
