import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readRuntimeConfig, readLlmConfig, assertRuntimeReady, PROVIDERS, ROLES, SUPPORTED_ENV_NAMES } from '../../../config/runtime.cjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { renderProductionEnv } = createRequire(import.meta.url)('../../../scripts/render-production-env.cjs') as {
  renderProductionEnv(contents: string): string;
};
const serialize = (env: Record<string, string>) => Object.entries(env).map(([name, value]) => `${name}='${value}'`).join('\n');
const showcase = {
  NODE_ENV: 'production', DIPLOMACY_PROFILE: 'showcase',
  DIPLOMACY_AUTH_CALLBACK_ORIGIN: 'https://game.example.test',
  DIPLOMACY_AUTH_RETURN_ORIGIN: 'https://game.example.test',
};

test('offline profiles fail closed without loading optional credentials', () => {
  for (const profile of ['showcase', 'local']) {
    const config = readRuntimeConfig({ DIPLOMACY_PROFILE: profile });
    assert.equal(config.discord.enabled, false);
    assert.equal(config.discord.voiceEnabled, false);
    assert.equal(config.llm.paidEnabled, false);
    assert.deepEqual(config.llm.allowedProviders, ['STUB']);
    assert.equal(config.notifyMode, 'outbox');
  }
  assert.deepEqual(readLlmConfig({ DIPLOMACY_PROFILE: 'showcase' }).allowedModels.OPENAI, ['gpt-6-luna']);
});

test('valid paid configuration still requires the durable admission implementation', () => {
  const config = readRuntimeConfig({
    ...showcase, DIPLOMACY_PAID_AI_ENABLED: 'true', LLM_TOTAL_BUDGET_USD: '2',
    DIPLOMACY_GITHUB_CLIENT_ID: 'synthetic', DIPLOMACY_GITHUB_CLIENT_SECRET: 'synthetic',
    DIPLOMACY_GOOGLE_CLIENT_ID: 'synthetic', DIPLOMACY_GOOGLE_CLIENT_SECRET: 'synthetic',
    DIPLOMACY_AUTH_SESSION_SECRET: 's'.repeat(32), DIPLOMACY_ADMIN_GITHUB_USER_IDS: '1234',
    OPENAI_API_KEY: 'synthetic',
  });
  assert.throws(() => assertRuntimeReady(config), /durable budget admission/);
  assert.throws(() => readRuntimeConfig({ DIPLOMACY_PROFILE: 'private', DIPLOMACY_AUTH_ENABLED: 'false' }), /cannot disable/);
});

test('production renderer preserves every supported setting, including aliases, secrets and limits', () => {
  const env: Record<string, string> = {
    ...showcase, DIPLOMACY_PROFILE: 'private', PORT: '4567', HOST: '0.0.0.0',
    CORS_ORIGINS: 'https://game.example.test,https://other.example.test',
    DIPLOMACY_ENV_FILE: '/never/load/local.env', DIPLOMACY_DATABASE_PATH: '/data/game.sqlite',
    DIPLOMACY_PAID_AI_ENABLED: 'true', DIPLOMACY_ENGINE_PATH: '/app/engine/bin/diplomacy-engine',
    DIPLOMACY_ENGINE_CONCURRENCY: '3', DIPLOMACY_ENGINE_MAX_QUEUE: '9',
    DIPLOMACY_ENGINE_TIMEOUT_MS: '2500', DIPLOMACY_ENGINE_MAX_OUTPUT_BYTES: '1048576',
    DIPLOMACY_AUTH_ENABLED: 'true', DIPLOMACY_AUTH_USERNAME: 'synthetic-owner',
    DIPLOMACY_AUTH_PASSWORD_SALT: '00'.repeat(16), DIPLOMACY_AUTH_PASSWORD_HASH: '11'.repeat(64),
    DIPLOMACY_AUTH_SESSION_SECRET: 'synthetic-secret$#='.repeat(3), DIPLOMACY_AUTH_COOKIE_SECURE: 'true',
    DIPLOMACY_ADMIN_GITHUB_USER_IDS: '1234,5678',
    DIPLOMACY_GITHUB_CLIENT_ID: 'synthetic-id', DIPLOMACY_GITHUB_CLIENT_SECRET: 'synthetic$#key',
    DIPLOMACY_GOOGLE_CLIENT_ID: 'synthetic-id', DIPLOMACY_GOOGLE_CLIENT_SECRET: 'synthetic$#key',
    OPENAI_API_KEY: 'synthetic$#key', GEMINI_API_KEY: 'synthetic$#key',
    LLM_ALLOWED_PROVIDERS: 'STUB,OPENAI,GEMINI', LLM_ALLOWED_MODELS: 'synthetic-global',
    LLM_MAX_GAME_COST_USD: '0.75', LLM_TOTAL_BUDGET_USD: '2', LLM_MAX_RETRIES: '2',
    LLM_REQUEST_TIMEOUT_MS: '12000', LLM_MAX_OUTPUT_TOKENS: '512', LLM_MAX_INPUT_TOKENS: '4096',
    DISCORD_ENABLED: 'true', DISCORD_GUILD_ID: 'synthetic-id', DISCORD_COORDINATOR_TOKEN: 'synthetic-token',
    DISCORD_VOICE_ENABLED: 'true', DISCORD_VOICE_DEBUG: 'false', DISCORD_VOICE_AUTO_LISTEN: 'false',
    DIPLOMACY_NOTIFY_MODE: 'resend', RESEND_API_KEY: 'synthetic-key',
    DIPLOMACY_NOTIFY_FROM: 'Game <notifications@example.test>', DIPLOMACY_NOTIFY_TO: 'owner@example.test',
    DIPLOMACY_MAX_ACTIVE_ATTEMPTS: '4', DIPLOMACY_MAX_ACTIVE_PER_ACCOUNT: '2',
    DIPLOMACY_DAILY_START_LIMIT: '5', DIPLOMACY_IDLE_WARN_MINUTES: '10', DIPLOMACY_IDLE_EXPIRE_MINUTES: '15',
    DIPLOMACY_RESULT_RETENTION_DAYS: '5', DIPLOMACY_DIAGNOSTIC_RETENTION_DAYS: '2', DIPLOMACY_RECEIPT_RETENTION_DAYS: '180',
  };
  for (const provider of PROVIDERS) {
    env[`LLM_ALLOWED_MODELS_${provider}`] = `synthetic-${provider}`;
    env[`${provider}_ALLOWED_MODELS`] = `synthetic-${provider}`;
  }
  for (const role of ROLES) env[`LLM_${role}_MODEL`] = 'synthetic-OPENAI';
  for (const provider of ['OPENAI', 'GEMINI']) {
    env[`LLM_DEFAULT_${provider}_MODEL`] = `synthetic-${provider}`;
    for (const role of ROLES) env[`LLM_${provider}_${role}_MODEL`] = `synthetic-${provider}`;
  }
  for (const power of ['AUSTRIA', 'ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY']) {
    env[`DISCORD_${power}_TOKEN`] = 'synthetic-token';
  }
  assert.deepEqual(new Set(Object.keys(env)), new Set(SUPPORTED_ENV_NAMES), 'each new supported setting needs a round-trip witness');
  const rendered = parseEnv(renderProductionEnv(serialize(env)));
  const { DIPLOMACY_ENV_FILE: _localPath, ...expected } = env;
  assert.deepEqual({ ...rendered }, expected);
  assert.deepEqual(readRuntimeConfig(rendered), readRuntimeConfig(env));
});

test('invalid and contradictory safety settings are rejected without echoing values', () => {
  const cases: Array<Record<string, string>> = [
    { LLM_MAX_GAME_COST_USD: '-1' }, { LLM_MAX_RETRIES: '99' },
    { LLM_REQUEST_TIMEOUT_MS: 'synthetic-private-value-77' }, { LLM_MAX_OUTPUT_TOKENS: 'Infinity' },
    { LLM_MAX_INPUT_TOKENS: '1.5' }, { DIPLOMACY_PAID_AI_ENABLED: 'yes' },
    { LLM_TOTAL_BUDGET_USD: '-2' }, { DIPLOMACY_ENGINE_MAX_QUEUE: '-1' },
    { DIPLOMACY_IDLE_WARN_MINUTES: '30' }, { DIPLOMACY_MAX_ACTIVE_PER_ACCOUNT: '4' },
    { LLM_ALLOWED_PROVIDERS: 'OPENAI,TYPO' }, { LLM_TYPO_TIMEOUT: '2500' },
    { DIPLOMACY_AUTH_ENABLED: 'false' }, { DISCORD_ENABLED: 'true' },
    { DISCORD_VOICE_ENABLED: 'true' }, { LLM_ALLOWED_MODELS_OPENAI: 'gpt-5.4-mini' },
    { LLM_OPENAI_ORDERS_MODEL: 'gpt-5.4-mini' },
    { CORS_ORIGINS: '*' }, { DIPLOMACY_AUTH_RETURN_ORIGIN: 'https://user:synthetic-private-value-77@example.test' },
    { DIPLOMACY_AUTH_COOKIE_SECURE: 'false' }, { DIPLOMACY_GITHUB_CLIENT_ID: 'synthetic' },
    { DIPLOMACY_PAID_AI_ENABLED: 'true' }, { DIPLOMACY_NOTIFY_MODE: 'resend' },
  ];
  for (const bad of cases) {
    assert.throws(() => readRuntimeConfig({ ...showcase, ...bad }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('synthetic-private-value-77'));
      return true;
    }, JSON.stringify(Object.keys(bad)));
  }
});

test('production renderer validates before writing, preserves source and replaces output with mode 600', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'diplomacy-config-'));
  try {
    const source = resolve(dir, 'source.env'), output = resolve(dir, 'output.env');
    const content = serialize(showcase);
    writeFileSync(source, content, { mode: 0o600 });
    writeFileSync(output, 'old-output', { mode: 0o644 });
    execFileSync(process.execPath, [resolve(root, 'scripts/render-production-env.cjs'), source, output]);
    assert.equal(readFileSync(source, 'utf8'), content);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const previous = readFileSync(output, 'utf8');
    writeFileSync(source, content + '\nLLM_MAX_RETRIES=SECRET');
    assert.throws(() => execFileSync(process.execPath, [resolve(root, 'scripts/render-production-env.cjs'), source, output], { stdio: 'pipe' }));
    assert.equal(readFileSync(output, 'utf8'), previous);
    assert.throws(() => execFileSync(process.execPath, [resolve(root, 'scripts/render-production-env.cjs'), source, source], { stdio: 'pipe' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('showcase server starts without Discord or provider secrets and serves health without login', async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, [resolve(root, 'server/dist/index.js')], {
    env: { ...showcase, HOST: '127.0.0.1', PORT: String(address.port), DIPLOMACY_ENV_FILE: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  try {
    let healthy = false;
    for (let count = 0; count < 100; count++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { healthy = true; break; }
      } catch { /* Startup may not yet be listening. */ }
      await delay(25);
    }
    assert.equal(healthy, true, output);
    assert.match(output, /Discord integration disabled/);
    const auth = await fetch(`http://127.0.0.1:${address.port}/api/auth/session`);
    assert.equal((await auth.json() as { authenticated: boolean }).authenticated, false);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
});
