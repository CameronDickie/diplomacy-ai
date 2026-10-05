#!/usr/bin/env node
// Watch compiled output, including SQLite's worker, without glob-parser dependencies.
const { watch } = require('node:fs');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
let child, debounce, busy = false, pending = false, stopping = false;

async function stopChild() {
  const target = child;
  if (!target || target.exitCode !== null || target.signalCode !== null) return;
  const closed = once(target, 'close');
  target.kill('SIGTERM');
  const deadline = setTimeout(() => target.kill('SIGKILL'), 12000);
  try { await closed; } finally { clearTimeout(deadline); }
}
async function restart() {
  if (stopping) return;
  if (busy) { pending = true; return; }
  busy = true;
  await stopChild();
  if (!stopping) {
    console.log('Starting compiled Diplomacy server');
    child = spawn(process.execPath, [resolve(root, 'server/dist/index.js')], {
      cwd: resolve(root, 'server'), env: process.env, stdio: 'inherit',
    });
    child.on('error', () => { console.error('Could not start the development server.'); });
  }
  busy = false;
  if (pending && !stopping) { pending = false; schedule(); }
}
function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(() => { void restart().catch(() => shutdown(1)); }, 250);
}
const watchers = ['server/dist', 'shared/dist', 'config'].map(directory =>
  watch(resolve(root, directory), { recursive: true }, (_event, filename) => {
    if (!filename || /\.(c?js|mjs)$/.test(String(filename))) schedule();
  })
);
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true; clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  try { await stopChild(); } finally { process.exit(code); }
}
for (const watcher of watchers) watcher.on('error', () => { void shutdown(1); });
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
void restart().catch(() => shutdown(1));
