#!/usr/bin/env node
// New installations only: never replace a configured secret or print it in logs.
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const destination = process.argv[2];
try {
  if (!destination || process.argv.length !== 3) throw new Error('Usage: npm run generate:auth-env -- <new-private-env-file>');
  fs.writeFileSync(destination, `DIPLOMACY_AUTH_SESSION_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  console.log('New session secret written with permissions 600. Configure OAuth credentials privately; preserve any existing secret.');
} catch {
  console.error('Could not create the secret file. Provide a new writable path; existing files are never replaced.');
  process.exitCode = 1;
}
