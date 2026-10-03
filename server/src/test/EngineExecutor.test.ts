import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer, createConnection } from 'node:net';
import { ALL_POWERS, gamePhaseId } from '@diplomacy/shared';
import { EngineExecutor } from '../adjudication/EngineExecutor.js';
import { GameRoom } from '../GameRoom.js';

const directory = mkdtempSync(resolve(tmpdir(), 'diplomacy-engine-test-'));
const executable = resolve(directory, 'engine.cjs');
const catalogCalls = resolve(directory, 'catalog-calls');
writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (request.operation === 'LEGAL_ORDERS') {
    fs.appendFileSync(${JSON.stringify(catalogCalls)}, request.power + '\\n');
    process.stdout.write(JSON.stringify({units: [], dislodged: [], resolutions: [], standoffs: [],
      legalOrders: request.units.filter(unit => unit.power === request.power)
        .map(unit => ({type: 'HOLD', unitTerritory: unit.territory, unitCoast: unit.coast}))}));
    return;
  }
  if (request.pidFile) fs.writeFileSync(request.pidFile, String(process.pid));
  if (request.mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (request.mode === 'flood') { process.stdout.write('x'.repeat(200000)); return; }
  if (request.mode === 'bad-json') { process.stdout.write('not-json'); return; }
  if (request.mode === 'failure') { process.stderr.write('synthetic-private-output'); process.exit(1); }
  setTimeout(() => process.stdout.write(JSON.stringify({value:request.value, apiKey:process.env.OPENAI_API_KEY ?? null})), request.delay ?? 0);
});
`, { mode: 0o700 });
after(() => rmSync(directory, { recursive: true, force: true }));
const limits = { concurrency: 1, maxQueue: 1, timeoutMs: 2000, maxOutputBytes: 4096 };

test('engine queue is bounded and a cancelled queued request frees admission immediately', async () => {
  const executor = new EngineExecutor(limits);
  const runningAbort = new AbortController(), queuedAbort = new AbortController();
  const running = executor.execute({ mode: 'hang' }, executable, runningAbort.signal);
  const runningFailure = assert.rejects(running, { code: 'ENGINE_CANCELLED' });
  const queued = executor.execute({ value: 'never' }, executable, queuedAbort.signal);
  const queuedFailure = assert.rejects(queued, { code: 'ENGINE_CANCELLED' });
  assert.deepEqual(executor.stats, { running: 1, queued: 1, closed: false });
  await assert.rejects(executor.execute({}, executable), { code: 'ENGINE_BUSY' });
  queuedAbort.abort();
  await queuedFailure;
  assert.equal(executor.stats.queued, 0);
  const replacement = executor.execute({ value: 'next' }, executable);
  runningAbort.abort();
  await runningFailure;
  assert.deepEqual(await replacement, { value: 'next', apiKey: null });
  assert.deepEqual(executor.stats, { running: 0, queued: 0, closed: false });
  await executor.close();
});

test('deadlines kill/reap hung processes and release queue slots before retry', async () => {
  const executor = new EngineExecutor({ ...limits, timeoutMs: 1000 });
  const pidFile = resolve(directory, 'hung.pid');
  await assert.rejects(executor.execute({ mode: 'hang', pidFile }, executable), { code: 'ENGINE_TIMEOUT' });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual(executor.stats, { running: 0, queued: 0, closed: false });
  assert.deepEqual(await executor.execute({ value: 'after-timeout' }, executable), { value: 'after-timeout', apiKey: null });
  await executor.close();
});

test('failed, oversized and malformed engine output is bounded and never echoed', async () => {
  const executor = new EngineExecutor(limits);
  for (const [mode, code] of [['flood', 'ENGINE_OUTPUT_LIMIT'], ['bad-json', 'ENGINE_INVALID_RESPONSE'], ['failure', 'ENGINE_FAILED']]) {
    await assert.rejects(executor.execute({ mode }, executable), error => {
      assert.equal((error as { code: string }).code, code);
      assert.ok(!(error as Error).message.includes('synthetic-private-output'));
      return true;
    });
    assert.equal(executor.stats.running, 0);
  }
  await assert.rejects(executor.execute({}, '/not-an-executable'), { code: 'ENGINE_FAILED' });
  await assert.rejects(executor.execute({ value: 'x'.repeat(4 * 1024 * 1024) }, executable), { code: 'ENGINE_INPUT_LIMIT' });
  assert.deepEqual(await executor.execute({ value: 'healthy' }, executable), { value: 'healthy', apiKey: null });
  await executor.close();
});

test('pool shutdown cancels running and queued work and rejects new dispatches', async () => {
  const executor = new EngineExecutor(limits);
  const first = assert.rejects(executor.execute({ mode: 'hang' }, executable), { code: 'ENGINE_CANCELLED' });
  const second = assert.rejects(executor.execute({ value: 'queued' }, executable), { code: 'ENGINE_CANCELLED' });
  await executor.close();
  await Promise.all([first, second]);
  assert.deepEqual(executor.stats, { running: 0, queued: 0, closed: true });
  await assert.rejects(executor.execute({}, executable), { code: 'ENGINE_CANCELLED' });
});

test('a hung engine leaves HTTP health and unrelated socket traffic responsive', async () => {
  const executor = new EngineExecutor({ ...limits, timeoutMs: 5000 });
  const abort = new AbortController();
  const pending = assert.rejects(executor.execute({ mode: 'hang' }, executable, abort.signal), { code: 'ENGINE_CANCELLED' });
  const http = httpServer((_req, response) => response.end('healthy'));
  const tcp = tcpServer(socket => socket.on('data', () => socket.end('pong')));
  http.listen(0, '127.0.0.1'); tcp.listen(0, '127.0.0.1');
  await Promise.all([once(http, 'listening'), once(tcp, 'listening')]);
  try {
    const httpAddress = http.address(), tcpAddress = tcp.address();
    assert.ok(httpAddress && typeof httpAddress === 'object' && tcpAddress && typeof tcpAddress === 'object');
    const socket = createConnection(tcpAddress.port, '127.0.0.1');
    try {
      const pong = once(socket, 'data');
      socket.write('ping');
      const response = await fetch(`http://127.0.0.1:${httpAddress.port}/healthz`, { signal: AbortSignal.timeout(2000) });
      assert.equal(await response.text(), 'healthy');
      assert.equal(String((await pong)[0]), 'pong');
      assert.equal(executor.stats.running, 1, 'engine is still hung while unrelated traffic completes');
    } finally { socket.destroy(); }
  } finally {
    abort.abort();
    await pending;
    http.close(); tcp.close();
    await executor.close();
  }
});

test('invalid engine response cannot advance the board and a fresh submission can retry', async () => {
  const room = new GameRoom();
  for (const power of ALL_POWERS) assert.ok(room.addPlayer(power, power, power));
  await room.startGame();
  for (const power of ALL_POWERS.filter(power => power !== 'TURKEY')) await room.submitOrders(power, []);
  const before = structuredClone(room.getState());
  const previousPath = process.env.DIPLOMACY_ENGINE_PATH;
  process.env.DIPLOMACY_ENGINE_PATH = executable;
  try {
    const result = await room.submitCommand('TURKEY', {
      phase: 'ORDERS', phaseId: gamePhaseId(before), requestId: 'malformed-engine', orders: [],
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error?.code, 'ENGINE_INVALID_RESPONSE');
    assert.deepEqual(room.getState().units, before.units);
    assert.equal(gamePhaseId(room.getState()), gamePhaseId(before));
    assert.equal(room.getPhaseHistory().length, 0);
    assert.equal(room.getState().submittedPowers.includes('TURKEY'), false);
  } finally {
    if (previousPath === undefined) delete process.env.DIPLOMACY_ENGINE_PATH;
    else process.env.DIPLOMACY_ENGINE_PATH = previousPath;
  }
  await room.submitOrders('TURKEY', []);
  assert.equal(room.getState().season, 'FALL');
  room.dispose();
});

test('legal catalog requests share work, return isolated copies and evict failed work', async () => {
  const room = new GameRoom();
  for (const power of ALL_POWERS) assert.ok(room.addPlayer(power, power, power));
  await room.startGame();
  const previousPath = process.env.DIPLOMACY_ENGINE_PATH;
  const restorePath = () => {
    if (previousPath === undefined) delete process.env.DIPLOMACY_ENGINE_PATH;
    else process.env.DIPLOMACY_ENGINE_PATH = previousPath;
  };
  const calls = () => readFileSync(catalogCalls, 'utf8').trim().split('\n');
  process.env.DIPLOMACY_ENGINE_PATH = executable;
  try {
    const [first, second] = await Promise.all([room.getLegalOrders('ENGLAND'), room.getLegalOrders('ENGLAND')]);
    assert.deepEqual(first, second);
    assert.deepEqual(calls(), ['ENGLAND'], 'concurrent callers dispatch only one process');
    first[0].order.unitTerritory = 'PAR';
    first.splice(0);
    assert.deepEqual(await room.getLegalOrders('ENGLAND'), second);
    assert.equal(calls().length, 1, 'completed work remains cached');
    process.env.DIPLOMACY_ENGINE_PATH = '/not-an-executable';
    await assert.rejects(room.getLegalOrders('FRANCE'), { code: 'ENGINE_FAILED' });
    process.env.DIPLOMACY_ENGINE_PATH = executable;
    assert.ok((await room.getLegalOrders('FRANCE')).length > 0, 'failed work is evicted for retry');
    assert.deepEqual(calls(), ['ENGLAND', 'FRANCE']);
    restorePath();
    for (const power of ALL_POWERS) await room.submitOrders(power, []);
    assert.equal(room.getState().season, 'FALL');
    process.env.DIPLOMACY_ENGINE_PATH = executable;
    await room.getLegalOrders('ENGLAND');
    assert.deepEqual(calls(), ['ENGLAND', 'FRANCE', 'ENGLAND'], 'a new phase invalidates the catalog');
    room.dispose();
    await assert.rejects(room.getLegalOrders('FRANCE'), { code: 'ENGINE_CANCELLED' });
  } finally { restorePath(); room.dispose(); }
});
