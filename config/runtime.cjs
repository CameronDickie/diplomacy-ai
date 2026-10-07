'use strict';

// This module is used directly by both deployment tooling and the Node server.
// It intentionally has no build step, provider SDK, filesystem or network effects.
const PROVIDERS = ['STUB', 'OPENAI', 'GEMINI', 'ANTHROPIC', 'OPENROUTER', 'OLLAMA'];
const ROLES = ['DIPLOMACY_INITIATIVE', 'DIPLOMACY_REPLY', 'ORDERS', 'RETREATS', 'BUILDS', 'MEMORY'];
const POWERS = ['AUSTRIA', 'ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'];
const DEFAULT_MODELS = {
  STUB: ['auto-hold-v0', 'idle'],
  OPENAI: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4'],
  GEMINI: ['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash'],
  ANTHROPIC: [], OPENROUTER: [], OLLAMA: [],
};
const DEFAULT_ROLES = {
  OPENAI: ['gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4-nano', 'gpt-5.4-mini'],
  GEMINI: ROLES.map(() => 'gemini-3.1-flash-lite'),
};

const SUPPORTED_ENV_NAMES = [
  'NODE_ENV', 'PORT', 'HOST', 'CORS_ORIGINS', 'DIPLOMACY_PROFILE', 'DIPLOMACY_ENV_FILE',
  'DIPLOMACY_PAID_AI_ENABLED', 'DIPLOMACY_DATABASE_PATH',
  'DIPLOMACY_ENGINE_PATH', 'DIPLOMACY_ENGINE_CONCURRENCY', 'DIPLOMACY_ENGINE_MAX_QUEUE',
  'DIPLOMACY_ENGINE_TIMEOUT_MS', 'DIPLOMACY_ENGINE_MAX_OUTPUT_BYTES',
  'DIPLOMACY_AUTH_ENABLED', 'DIPLOMACY_AUTH_USERNAME', 'DIPLOMACY_AUTH_PASSWORD_SALT',
  'DIPLOMACY_AUTH_PASSWORD_HASH', 'DIPLOMACY_AUTH_SESSION_SECRET', 'DIPLOMACY_AUTH_COOKIE_SECURE',
  'DIPLOMACY_AUTH_CALLBACK_ORIGIN', 'DIPLOMACY_AUTH_RETURN_ORIGIN', 'DIPLOMACY_ADMIN_GITHUB_USER_IDS',
  'DIPLOMACY_GITHUB_CLIENT_ID', 'DIPLOMACY_GITHUB_CLIENT_SECRET',
  'DIPLOMACY_GOOGLE_CLIENT_ID', 'DIPLOMACY_GOOGLE_CLIENT_SECRET',
  'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'LLM_ALLOWED_PROVIDERS', 'LLM_ALLOWED_MODELS',
  'LLM_MAX_GAME_COST_USD', 'LLM_TOTAL_BUDGET_USD', 'LLM_MAX_RETRIES',
  'LLM_REQUEST_TIMEOUT_MS', 'LLM_MAX_OUTPUT_TOKENS', 'LLM_MAX_INPUT_TOKENS',
  ...PROVIDERS.flatMap(provider => [`LLM_ALLOWED_MODELS_${provider}`, `${provider}_ALLOWED_MODELS`]),
  ...ROLES.map(role => `LLM_${role}_MODEL`),
  ...['OPENAI', 'GEMINI'].flatMap(provider => [
    `LLM_DEFAULT_${provider}_MODEL`, ...ROLES.map(role => `LLM_${provider}_${role}_MODEL`),
  ]),
  'DISCORD_ENABLED', 'DISCORD_GUILD_ID', 'DISCORD_COORDINATOR_TOKEN',
  ...POWERS.map(power => `DISCORD_${power}_TOKEN`),
  'DISCORD_VOICE_ENABLED', 'DISCORD_VOICE_DEBUG', 'DISCORD_VOICE_AUTO_LISTEN',
  'DIPLOMACY_NOTIFY_MODE', 'RESEND_API_KEY', 'DIPLOMACY_NOTIFY_FROM', 'DIPLOMACY_NOTIFY_TO',
  'DIPLOMACY_MAX_ACTIVE_ATTEMPTS', 'DIPLOMACY_MAX_ACTIVE_PER_ACCOUNT',
  'DIPLOMACY_DAILY_START_LIMIT', 'DIPLOMACY_IDLE_WARN_MINUTES', 'DIPLOMACY_IDLE_EXPIRE_MINUTES',
  'DIPLOMACY_RESULT_RETENTION_DAYS', 'DIPLOMACY_DIAGNOSTIC_RETENTION_DAYS', 'DIPLOMACY_RECEIPT_RETENTION_DAYS',
  'DIPLOMACY_TRUSTED_PROXY', 'DIPLOMACY_LUNA_TRANSPORT',
];

function fail(name, requirement) {
  // Never include rejected values: a misconfigured field may contain a secret.
  throw new Error(`${name}: ${requirement}`);
}
function value(env, name, fallback = '') {
  return env[name] === undefined ? fallback : String(env[name]).trim();
}
function bool(env, name, fallback) {
  const raw = value(env, name, String(fallback));
  if (raw !== 'true' && raw !== 'false') fail(name, 'must be true or false');
  return raw === 'true';
}
function number(env, name, fallback, min, max, integer = false) {
  const raw = value(env, name, String(fallback));
  const result = Number(raw);
  if (!raw || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isSafeInteger(result))) {
    fail(name, `must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return result;
}
function list(raw) { return [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))]; }
function profile(env) {
  const result = value(env, 'DIPLOMACY_PROFILE', env.NODE_ENV === 'production' ? 'showcase' : 'local');
  if (!['showcase', 'private', 'local'].includes(result)) fail('DIPLOMACY_PROFILE', 'must be showcase, private, or local');
  return result;
}
function requireValue(env, name) { if (!value(env, name)) fail(name, 'is required for the enabled feature'); }
function origin(env, name, fallback, production) {
  const raw = value(env, name, fallback);
  let url;
  try { url = new URL(raw); } catch { fail(name, 'must be an absolute HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== raw || url.username || url.password) {
    fail(name, 'must be an exact HTTP(S) origin without path, credentials, query, or fragment');
  }
  if (production && url.protocol !== 'https:') fail(name, 'must use HTTPS in production');
  return raw;
}

function readLlmConfig(env = process.env) {
  for (const name of Object.keys(env)) {
    if (name.startsWith('LLM_') && !SUPPORTED_ENV_NAMES.includes(name)) fail(name, 'is not a supported LLM setting');
  }
  const mode = profile(env);
  const paidEnabled = bool(env, 'DIPLOMACY_PAID_AI_ENABLED', false);
  const configuredProviders = list(value(env, 'LLM_ALLOWED_PROVIDERS', mode === 'showcase' ? 'STUB,OPENAI' : 'STUB,OPENAI,GEMINI'));
  if (!configuredProviders.length || configuredProviders.some(item => !PROVIDERS.includes(item))) {
    fail('LLM_ALLOWED_PROVIDERS', `must be a nonempty list from ${PROVIDERS.join(',')}`);
  }
  if (mode === 'showcase' && configuredProviders.some(item => !['STUB', 'OPENAI'].includes(item))) {
    fail('LLM_ALLOWED_PROVIDERS', 'showcase only supports STUB and OPENAI');
  }
  const allowedModels = {};
  for (const provider of PROVIDERS) {
    const defaults = mode === 'showcase' && provider === 'OPENAI' ? ['gpt-6-luna'] : DEFAULT_MODELS[provider];
    allowedModels[provider] = list(value(env, `LLM_ALLOWED_MODELS_${provider}`,
      value(env, `${provider}_ALLOWED_MODELS`, value(env, 'LLM_ALLOWED_MODELS', defaults.join(',')))));
    if (configuredProviders.includes(provider) && !allowedModels[provider].length) fail(`LLM_ALLOWED_MODELS_${provider}`, 'must not be empty for an allowed provider');
  }
  if (mode === 'showcase' && (allowedModels.OPENAI.length !== 1 || allowedModels.OPENAI[0] !== 'gpt-6-luna')) {
    fail('LLM_ALLOWED_MODELS_OPENAI', 'showcase requires exactly gpt-6-luna');
  }
  const defaultModels = {};
  for (const provider of ['OPENAI', 'GEMINI']) {
    defaultModels[provider] = {};
    ROLES.forEach((role, index) => {
      const model = value(env, `LLM_${provider}_${role}_MODEL`, value(env, `LLM_${role}_MODEL`,
        value(env, `LLM_DEFAULT_${provider}_MODEL`, mode === 'showcase' && provider === 'OPENAI' ? 'gpt-6-luna' : DEFAULT_ROLES[provider][index])));
      defaultModels[provider][role] = model;
      if (configuredProviders.includes(provider) && !allowedModels[provider].includes(model)) {
        fail(`LLM_${provider}_${role}_MODEL`, 'default must belong to the provider model allowlist');
      }
    });
  }
  const maxGameSpendUsd = number(env, 'LLM_MAX_GAME_COST_USD', 1, 0.000001, mode === 'showcase' ? 15 : 1000000);
  const totalBudgetUsd = number(env, 'LLM_TOTAL_BUDGET_USD', 0, 0, 1000000);
  if (paidEnabled && totalBudgetUsd <= 0) fail('LLM_TOTAL_BUDGET_USD', 'must be explicitly positive before paid AI is enabled');
  if (paidEnabled && maxGameSpendUsd > totalBudgetUsd) fail('LLM_MAX_GAME_COST_USD', 'must not exceed LLM_TOTAL_BUDGET_USD');
  return {
    paidEnabled, configuredProviders,
    allowedProviders: paidEnabled ? configuredProviders : configuredProviders.filter(item => item === 'STUB'),
    allowedModels, defaultModels, maxGameSpendUsd, totalBudgetUsd,
    maxRetries: number(env, 'LLM_MAX_RETRIES', 1, 0, 3, true),
    requestTimeoutMs: number(env, 'LLM_REQUEST_TIMEOUT_MS', 30000, 1000, 120000, true),
    maxOutputTokens: number(env, 'LLM_MAX_OUTPUT_TOKENS', 2048, 256, 16384, true),
    maxInputTokens: number(env, 'LLM_MAX_INPUT_TOKENS', 16000, 256, 128000, true),
  };
}

function readRuntimeConfig(env = process.env, options = {}) {
  const mode = profile(env);
  const production = env.NODE_ENV === 'production' || options.production === true;
  if (production && mode === 'local') fail('DIPLOMACY_PROFILE', 'local cannot run in production');
  const llm = readLlmConfig(env);
  const authEnabled = bool(env, 'DIPLOMACY_AUTH_ENABLED', mode !== 'local' || production);
  if ((mode !== 'local' || production) && !authEnabled) fail('DIPLOMACY_AUTH_ENABLED', 'cannot disable authentication in private, showcase or production');
  const discordEnabled = bool(env, 'DISCORD_ENABLED', false);
  const voiceEnabled = bool(env, 'DISCORD_VOICE_ENABLED', false);
  if (mode === 'showcase' && (discordEnabled || voiceEnabled)) fail('DISCORD_ENABLED', 'Discord and voice must be disabled in showcase');
  if (voiceEnabled && !discordEnabled) fail('DISCORD_VOICE_ENABLED', 'requires DISCORD_ENABLED=true');
  if (discordEnabled) {
    requireValue(env, 'DISCORD_GUILD_ID'); requireValue(env, 'DISCORD_COORDINATOR_TOKEN');
  }
  if (voiceEnabled) {
    requireValue(env, 'OPENAI_API_KEY');
    for (const power of POWERS) requireValue(env, `DISCORD_${power}_TOKEN`);
    if (!llm.paidEnabled) fail('DISCORD_VOICE_ENABLED', 'requires explicit paid AI enablement');
  }
  const callbackOrigin = origin(env, 'DIPLOMACY_AUTH_CALLBACK_ORIGIN', 'http://localhost:3001', production);
  const returnOrigin = origin(env, 'DIPLOMACY_AUTH_RETURN_ORIGIN', 'http://localhost:5173', production);
  const corsOrigins = list(value(env, 'CORS_ORIGINS', returnOrigin));
  for (const item of corsOrigins) origin({CORS_ORIGINS:item}, 'CORS_ORIGINS', '', production);
  if (!corsOrigins.includes(returnOrigin)) fail('CORS_ORIGINS', 'must include DIPLOMACY_AUTH_RETURN_ORIGIN');
  const cookieSecure = bool(env, 'DIPLOMACY_AUTH_COOKIE_SECURE', production);
  if (production && !cookieSecure) fail('DIPLOMACY_AUTH_COOKIE_SECURE', 'must be true in production');
  for (const provider of ['GITHUB', 'GOOGLE']) {
    const id = `DIPLOMACY_${provider}_CLIENT_ID`, secret = `DIPLOMACY_${provider}_CLIENT_SECRET`;
    if (value(env, id) || value(env, secret) || (mode === 'showcase' && llm.paidEnabled)) {
      requireValue(env, id); requireValue(env, secret); requireValue(env, 'DIPLOMACY_AUTH_SESSION_SECRET');
    }
  }
  if (value(env, 'DIPLOMACY_AUTH_SESSION_SECRET') && value(env, 'DIPLOMACY_AUTH_SESSION_SECRET').length < 32) {
    fail('DIPLOMACY_AUTH_SESSION_SECRET', 'must contain at least 32 characters');
  }
  const admins = list(value(env, 'DIPLOMACY_ADMIN_GITHUB_USER_IDS'));
  if (admins.some(id => !/^[1-9][0-9]*$/.test(id))) fail('DIPLOMACY_ADMIN_GITHUB_USER_IDS', 'must contain immutable numeric GitHub user IDs');
  if (mode === 'showcase' && llm.paidEnabled && !admins.length) fail('DIPLOMACY_ADMIN_GITHUB_USER_IDS', 'must name an owner before paid AI is enabled');
  if (llm.paidEnabled) {
    for (const provider of llm.allowedProviders) {
      if (provider === 'OPENAI' || provider === 'GEMINI') requireValue(env, `${provider}_API_KEY`);
      else if (provider !== 'STUB') fail('LLM_ALLOWED_PROVIDERS', 'selected provider adapter is not implemented');
    }
  }
  const notifyMode = value(env, 'DIPLOMACY_NOTIFY_MODE', 'outbox');
  if (!['outbox', 'resend'].includes(notifyMode)) fail('DIPLOMACY_NOTIFY_MODE', 'must be outbox or resend');
  if (notifyMode === 'resend') {
    for (const name of ['RESEND_API_KEY', 'DIPLOMACY_NOTIFY_FROM', 'DIPLOMACY_NOTIFY_TO']) requireValue(env, name);
  }
  const trustedProxy = value(env, 'DIPLOMACY_TRUSTED_PROXY', 'none');
  if (!['none', 'private'].includes(trustedProxy)) fail('DIPLOMACY_TRUSTED_PROXY', 'must be none or private');
  // `mock` plays sponsored attempts against a deterministic local stand-in. It makes no provider
  // call and is refused anywhere a visitor could mistake it for the real opponent.
  const lunaTransport = value(env, 'DIPLOMACY_LUNA_TRANSPORT', 'none');
  if (!['none', 'mock'].includes(lunaTransport)) fail('DIPLOMACY_LUNA_TRANSPORT', 'must be none or mock');
  if (lunaTransport === 'mock' && (mode !== 'local' || production)) fail('DIPLOMACY_LUNA_TRANSPORT', 'mock is only available in the local development profile');
  const idleWarnMinutes = number(env, 'DIPLOMACY_IDLE_WARN_MINUTES', 25, 1, 1440, true);
  const idleExpireMinutes = number(env, 'DIPLOMACY_IDLE_EXPIRE_MINUTES', 30, 2, 1440, true);
  if (idleWarnMinutes >= idleExpireMinutes) fail('DIPLOMACY_IDLE_WARN_MINUTES', 'must be less than DIPLOMACY_IDLE_EXPIRE_MINUTES');
  const maxActiveAttempts = number(env, 'DIPLOMACY_MAX_ACTIVE_ATTEMPTS', 3, 1, 100, true);
  const maxActivePerAccount = number(env, 'DIPLOMACY_MAX_ACTIVE_PER_ACCOUNT', 1, 1, 100, true);
  if (maxActivePerAccount > maxActiveAttempts) fail('DIPLOMACY_MAX_ACTIVE_PER_ACCOUNT', 'must not exceed global capacity');
  return {
    profile: mode, production, llm, authEnabled, callbackOrigin, returnOrigin, cookieSecure, corsOrigins,
    host: value(env, 'HOST', mode === 'local' ? '127.0.0.1' : '0.0.0.0'),
    port: number(env, 'PORT', 3001, 1, 65535, true),
    databasePath: value(env, 'DIPLOMACY_DATABASE_PATH', production ? '/data/diplomacy.sqlite' : './data/diplomacy.sqlite'),
    discord: { enabled: discordEnabled, voiceEnabled,
      voiceDebug: bool(env, 'DISCORD_VOICE_DEBUG', false), autoListen: bool(env, 'DISCORD_VOICE_AUTO_LISTEN', true) },
    engine: readEngineConfig(env),
    notifyMode, admins, trustedProxy, lunaTransport, idleWarnMinutes, idleExpireMinutes, maxActiveAttempts, maxActivePerAccount,
    dailyStartLimit: number(env, 'DIPLOMACY_DAILY_START_LIMIT', 3, 1, 100, true),
    resultRetentionDays: number(env, 'DIPLOMACY_RESULT_RETENTION_DAYS', 30, 1, 365, true),
    diagnosticRetentionDays: number(env, 'DIPLOMACY_DIAGNOSTIC_RETENTION_DAYS', 7, 1, 365, true),
    receiptRetentionDays: number(env, 'DIPLOMACY_RECEIPT_RETENTION_DAYS', 90, 1, 3650, true),
  };
}

function readEngineConfig(env = process.env) {
  return {
    path: value(env, 'DIPLOMACY_ENGINE_PATH'),
    concurrency: number(env, 'DIPLOMACY_ENGINE_CONCURRENCY', 2, 1, 32, true),
    maxQueue: number(env, 'DIPLOMACY_ENGINE_MAX_QUEUE', 16, 0, 256, true),
    timeoutMs: number(env, 'DIPLOMACY_ENGINE_TIMEOUT_MS', 10000, 50, 120000, true),
    maxOutputBytes: number(env, 'DIPLOMACY_ENGINE_MAX_OUTPUT_BYTES', 4194304, 1024, 16777216, true),
  };
}

function assertRuntimeReady(config) {
  // The ledger exists (docs/funding.md). Removed only when the provider adapter dispatches exclusively through it.
  if (config.llm.paidEnabled) fail('DIPLOMACY_PAID_AI_ENABLED', 'paid startup awaits the funded provider adapter (DIC-60); use false for offline development');
}

module.exports = { SUPPORTED_ENV_NAMES, PROVIDERS, ROLES, readLlmConfig, readRuntimeConfig, assertRuntimeReady, readEngineConfig };
