#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { SUPPORTED_ENV_NAMES, readRuntimeConfig } = require('../config/runtime.cjs');

function renderProductionEnv(contents) {
  const source = parseEnv(contents);
  const env = { ...source, NODE_ENV: 'production' };
  if (!source.DIPLOMACY_PROFILE) throw new Error('DIPLOMACY_PROFILE: explicitly select showcase or private for deployment');
  if (source.DIPLOMACY_PROFILE === 'local') throw new Error('DIPLOMACY_PROFILE: local cannot be rendered for production');
  // Never import a host-local environment file inside a deployment container.
  delete env.DIPLOMACY_ENV_FILE;
  readRuntimeConfig(env);
  const lines = [];
  for (const name of SUPPORTED_ENV_NAMES) {
    if (env[name] === undefined || env[name] === '') continue;
    // Single quoting prevents Compose interpolation of '$'. Fail rather than
    // silently altering credentials that cannot be represented consistently.
    if (env[name].includes("'") || env[name].includes('\0') || env[name].includes('\r')) {
      throw new Error(`${name}: cannot safely serialize apostrophes, NUL or carriage returns`);
    }
    lines.push(`${name}='${env[name]}'`);
  }
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const [, , inputPath, outputPath] = process.argv;
  try {
    if (!inputPath || !outputPath) throw new Error('Usage: node scripts/render-production-env.cjs <source-env> <output-env>');
    const source = path.resolve(inputPath), destination = path.resolve(outputPath);
    if (source === destination || (fs.existsSync(destination) && fs.realpathSync(source) === fs.realpathSync(destination))) {
      throw new Error('Output must differ from the source environment file');
    }
    const output = renderProductionEnv(fs.readFileSync(source, 'utf8'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, output, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, destination);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    console.log('Production environment validated and written with permissions 600.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { renderProductionEnv };
