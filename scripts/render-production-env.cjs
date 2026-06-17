#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/render-production-env.cjs <source-env> <output-env>');
  process.exit(1);
}

const powerTokenNames = [
  'DISCORD_AUSTRIA_TOKEN',
  'DISCORD_ENGLAND_TOKEN',
  'DISCORD_FRANCE_TOKEN',
  'DISCORD_GERMANY_TOKEN',
  'DISCORD_ITALY_TOKEN',
  'DISCORD_RUSSIA_TOKEN',
  'DISCORD_TURKEY_TOKEN',
];

const allowedNames = [
  'PORT',
  'CORS_ORIGINS',
  'DIPLOMACY_AUTH_ENABLED',
  'DIPLOMACY_AUTH_USERNAME',
  'DIPLOMACY_AUTH_PASSWORD_SALT',
  'DIPLOMACY_AUTH_PASSWORD_HASH',
  'DIPLOMACY_AUTH_SESSION_SECRET',
  'DIPLOMACY_AUTH_COOKIE_SECURE',
  'OPENAI_API_KEY',
  'DISCORD_GUILD_ID',
  'DISCORD_COORDINATOR_TOKEN',
  ...powerTokenNames,
  'DISCORD_VOICE_ENABLED',
  'DISCORD_VOICE_DEBUG',
  'DISCORD_VOICE_AUTO_LISTEN',
];

const requiredNames = [
  'CORS_ORIGINS',
  'DIPLOMACY_AUTH_USERNAME',
  'DIPLOMACY_AUTH_PASSWORD_SALT',
  'DIPLOMACY_AUTH_PASSWORD_HASH',
  'DIPLOMACY_AUTH_SESSION_SECRET',
  'OPENAI_API_KEY',
  'DISCORD_GUILD_ID',
  'DISCORD_COORDINATOR_TOKEN',
];

function parseEnv(contents) {
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

function serializeValue(value) {
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

const source = path.resolve(inputPath);
const destination = path.resolve(outputPath);

if (!fs.existsSync(source)) {
  console.error(`Missing environment source file: ${source}`);
  process.exit(1);
}

const values = parseEnv(fs.readFileSync(source, 'utf8'));
const missing = requiredNames.filter(name => !values.get(name));
if (missing.length) {
  console.error(`Missing required production variables: ${missing.join(', ')}`);
  process.exit(1);
}

const voiceEnabled = values.get('DISCORD_VOICE_ENABLED') === 'true';
if (voiceEnabled) {
  const missingPowerTokens = powerTokenNames.filter(name => !values.get(name));
  if (missingPowerTokens.length) {
    console.error(
      `DISCORD_VOICE_ENABLED=true requires all power bot tokens: ${missingPowerTokens.join(', ')}`
    );
    process.exit(1);
  }
}

if (!values.get('PORT')) values.set('PORT', '3001');
if (!values.get('DIPLOMACY_AUTH_ENABLED')) values.set('DIPLOMACY_AUTH_ENABLED', 'true');
if (!values.get('DISCORD_VOICE_ENABLED')) values.set('DISCORD_VOICE_ENABLED', 'false');
if (!values.get('DISCORD_VOICE_DEBUG')) values.set('DISCORD_VOICE_DEBUG', 'false');
if (!values.get('DISCORD_VOICE_AUTO_LISTEN')) values.set('DISCORD_VOICE_AUTO_LISTEN', 'true');

const output = [];
for (const name of allowedNames) {
  const value = values.get(name);
  if (value === undefined || value === '') continue;
  output.push(`${name}=${serializeValue(value)}`);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${output.join('\n')}\n`, { mode: 0o600 });
console.log(`Rendered ${output.length} production variables to ${destination}`);
