import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('compiled development watcher reloads worker/shared/config changes and shuts down its server', { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(resolve(tmpdir(), 'diplomacy-watch-'));
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const address = listener.address(); assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(done => listener.close(() => done()));
  const child = spawn(process.execPath, [resolve(root, 'scripts/watch-server.cjs')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, DIPLOMACY_ENV_FILE: '/dev/null', DIPLOMACY_PROFILE: 'local',
      HOST: '127.0.0.1', PORT: String(port), DIPLOMACY_DATABASE_PATH: resolve(directory, 'game.sqlite') },
  });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-65536); });
  async function ready(count: number) {
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, output);
      if ((output.match(/Persistent storage ready/g) ?? []).length >= count) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return;
        } catch { /* New server may still be binding. */ }
      }
      await delay(25);
    }
    assert.fail(`Development server did not reach restart ${count}: ${output}`);
  }
  try {
    await ready(1);
    let count = 1;
    for (const file of ['server/dist/storage/worker.js', 'shared/dist/index.js', 'config/runtime.cjs']) {
      // Exercise the actual compiled watcher without modifying source or secrets.
      const now = new Date(); await utimes(resolve(root, file), now, now);
      await ready(++count);
    }
    child.kill('SIGTERM');
    const [code, signal] = await closed;
    assert.equal(code, 0, output); assert.equal(signal, null);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed; }
    await rm(directory, { recursive: true, force: true });
  }
});
