import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { readLlmConfig, readRuntimeConfig } from '../../../config/runtime.cjs';
import { createPowerController } from '../llm/createPowerController.js';
import { OllamaProvider, OllamaSetupError } from '../llm/OllamaProvider.js';
import { buildLlmRuntimePolicy, estimateLlmCostUsd, isProviderAllowed, resolveLlmModel } from '../llm/policy.js';

type Handler = (path: string, body: Record<string, unknown>, res: ServerResponse) => void | Promise<void>;
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

/** A stand-in Ollama server on a loopback port that records every request it receives. */
async function ollama(t: test.TestContext, handler: Handler) {
  const seen: Array<{ path: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ path: req.url ?? '', body, headers: req.headers });
      void handler(req.url ?? '', body, res);
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const ask = (provider: OllamaProvider, model = 'qwen3:8b', timeoutMs = 2_000) => provider.completeJson<{ orders: string[] }>({
  model, timeoutMs, maxOutputTokens: 512, system: 'You are ENGLAND.', prompt: 'Choose orders.',
  schemaName: 'orders', schema: { type: 'object', properties: { orders: { type: 'array', items: { type: 'string' } } }, required: ['orders'] },
});
const installed: Handler = (path, _body, res) => path === '/api/show'
  ? json(res, 200, { capabilities: ['completion', 'tools'] })
  : json(res, 200, { message: { content: '{"orders":["LON|HOLD"]}' }, done: true, done_reason: 'stop', prompt_eval_count: 321, eval_count: 12 });

test('a structured request sends the schema to the configured endpoint only, with no key, and reports usage', async t => {
  const f = await ollama(t, installed), provider = new OllamaProvider(f.url);
  const result = await ask(provider);
  assert.deepEqual(result, { value: { orders: ['LON|HOLD'] }, usage: { inputTokens: 321, outputTokens: 12 } });
  const chat = f.seen.find(x => x.path === '/api/chat')!;
  assert.equal(chat.body.model, 'qwen3:8b'); assert.equal(chat.body.stream, false);
  assert.deepEqual((chat.body.format as { required: string[] }).required, ['orders']);
  assert.deepEqual(chat.body.options, { temperature: 0, num_predict: 512 });
  assert.deepEqual((chat.body.messages as Array<{ role: string }>).map(m => m.role), ['system', 'user']);
  assert.equal(chat.headers.authorization, undefined);
  // The capability check runs once per model, not once per decision.
  await ask(provider); await ask(provider);
  assert.equal(f.seen.filter(x => x.path === '/api/show').length, 1);
  assert.equal(f.seen.filter(x => x.path === '/api/chat').length, 3);
});

test('a missing model, an embedding-only model and an unreachable server each say what to do, and generate nothing', async t => {
  const missing = await ollama(t, (_path, _body, res) => json(res, 404, { error: 'model not found' }));
  await assert.rejects(ask(new OllamaProvider(missing.url), 'llama9'), (e: Error) => e instanceof OllamaSetupError && /ollama pull llama9/.test(e.message));
  assert.equal(missing.seen.some(x => x.path === '/api/chat'), false);

  const embed = await ollama(t, (_path, _body, res) => json(res, 200, { capabilities: ['embedding'] }));
  await assert.rejects(ask(new OllamaProvider(embed.url), 'nomic-embed-text'), (e: Error) => e instanceof OllamaSetupError && /cannot generate text/.test(e.message));
  assert.equal(embed.seen.some(x => x.path === '/api/chat'), false);

  await assert.rejects(ask(new OllamaProvider('http://127.0.0.1:1')), (e: Error) => e instanceof OllamaSetupError && /not reachable at http:\/\/127\.0\.0\.1:1.*ollama serve/.test(e.message));

  const other = await ollama(t, (_path, _body, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hello</html>'); });
  await assert.rejects(ask(new OllamaProvider(other.url)), /did not answer like an Ollama server/);
});

test('a failed capability check is retried, so installing the model fixes play without a restart', async t => {
  let pulled = false;
  const f = await ollama(t, (path, body, res) => pulled ? installed(path, body, res) : json(res, 404, { error: 'model not found' }));
  const provider = new OllamaProvider(f.url);
  await assert.rejects(ask(provider), /is not installed/);
  pulled = true;
  assert.deepEqual((await ask(provider)).value, { orders: ['LON|HOLD'] });
});

test('prose instead of JSON, a truncated answer, an empty answer and a server error are failures, never a pretend decision', async t => {
  const reply = (chat: unknown, status = 200): Handler => (path, _body, res) => path === '/api/show' ? json(res, 200, {}) : json(res, status, chat);
  const prose = await ollama(t, reply({ message: { content: 'Sure! I would hold in London.' }, done: true }));
  await assert.rejects(ask(new OllamaProvider(prose.url)), (e: Error) => e instanceof OllamaSetupError && /did not return JSON for orders/.test(e.message));
  const cut = await ollama(t, reply({ message: { content: '{"orders":["LON' }, done: true, done_reason: 'length' }));
  await assert.rejects(ask(new OllamaProvider(cut.url)), /ran out of output tokens/);
  const empty = await ollama(t, reply({ message: { content: '' }, done: true }));
  await assert.rejects(ask(new OllamaProvider(empty.url)), /returned no content/);
  const broken = await ollama(t, reply({ error: 'model requires more system memory' }, 500));
  await assert.rejects(ask(new OllamaProvider(broken.url)), /more system memory/);
});

test('a slow model is cancelled at the deadline with a useful message, and redirects are never followed', async t => {
  const slow = await ollama(t, (path, _body, res) => { if (path === '/api/show') json(res, 200, {}); /* the chat answer never comes */ });
  const started = Date.now();
  await assert.rejects(ask(new OllamaProvider(slow.url), 'qwen3:8b', 150), /did not answer in time/);
  assert.ok(Date.now() - started < 1_500);
  const elsewhere = await ollama(t, installed);
  const redirect = await ollama(t, (_path, _body, res) => { res.writeHead(307, { Location: `${elsewhere.url}/api/show` }); res.end(); });
  await assert.rejects(ask(new OllamaProvider(redirect.url)), OllamaSetupError);
  assert.equal(elsewhere.seen.length, 0);
});

test('Ollama is a local provider: allowed without the paid switch or any cloud key, refused in showcase, free, and allowlisted', () => {
  const env = { DIPLOMACY_PROFILE: 'local', LLM_ALLOWED_PROVIDERS: 'STUB,OLLAMA', LLM_ALLOWED_MODELS_OLLAMA: 'qwen3:8b,llama3.3' };
  const config = readRuntimeConfig(env);
  assert.equal(config.llm.paidEnabled, false);
  assert.deepEqual(config.llm.allowedProviders, ['STUB', 'OLLAMA']);
  assert.equal(config.llm.ollamaBaseUrl, 'http://127.0.0.1:11434');
  const policy = buildLlmRuntimePolicy(env);
  assert.equal(isProviderAllowed(policy, 'OLLAMA'), true);
  assert.equal(resolveLlmModel({ policy, provider: 'OLLAMA', role: 'ORDERS' }), 'qwen3:8b');
  assert.equal(resolveLlmModel({ policy, provider: 'OLLAMA', role: 'ORDERS', requestedModel: 'llama3.3' }), 'llama3.3');
  assert.throws(() => resolveLlmModel({ policy, provider: 'OLLAMA', role: 'ORDERS', requestedModel: 'not-pulled' }), /not allowed by server policy/);
  assert.equal(readLlmConfig({ ...env, LLM_DEFAULT_OLLAMA_MODEL: 'llama3.3', LLM_OLLAMA_BUILDS_MODEL: 'qwen3:8b' }).defaultModels.OLLAMA?.ORDERS, 'llama3.3');
  assert.equal(estimateLlmCostUsd({ provider: 'OLLAMA', model: 'qwen3:8b', inputTokens: 5_000, outputTokens: 500 }), 0);
  // Cloud providers stay behind the paid switch even when Ollama is on.
  assert.deepEqual(readLlmConfig({ ...env, LLM_ALLOWED_PROVIDERS: 'STUB,OLLAMA,OPENAI' }).allowedProviders, ['STUB', 'OLLAMA']);
  // An allowed provider needs a named model, a default from its allowlist, and a plain origin for an endpoint.
  assert.throws(() => readLlmConfig({ LLM_ALLOWED_PROVIDERS: 'STUB,OLLAMA' }), /LLM_ALLOWED_MODELS_OLLAMA/);
  assert.throws(() => readLlmConfig({ ...env, LLM_DEFAULT_OLLAMA_MODEL: 'other' }), /allowlist/);
  for (const bad of ['ollama.internal:11434', 'http://user:pw@127.0.0.1:11434', 'http://127.0.0.1:11434/api', 'file:///etc/passwd'])
    assert.throws(() => readLlmConfig({ ...env, OLLAMA_BASE_URL: bad }), /OLLAMA_BASE_URL/, bad);
  assert.equal(readLlmConfig({ ...env, OLLAMA_BASE_URL: 'http://gpu-box.lan:11434' }).ollamaBaseUrl, 'http://gpu-box.lan:11434');
  assert.throws(() => readRuntimeConfig({ NODE_ENV: 'production', DIPLOMACY_PROFILE: 'showcase', LLM_ALLOWED_PROVIDERS: 'STUB,OLLAMA', LLM_ALLOWED_MODELS_OLLAMA: 'qwen3:8b' }), /showcase only supports STUB and OPENAI/);
  // Without Ollama configured nothing changes for existing installs.
  assert.deepEqual(readLlmConfig({}).allowedProviders, ['STUB']);
  assert.equal(readLlmConfig({}).defaultModels.OLLAMA, undefined);
});

test('the controller factory builds an Ollama-backed power and still refuses adapters that do not exist', () => {
  const controller = createPowerController({ power: 'ENGLAND', provider: 'OLLAMA', model: 'qwen3:8b', ollamaBaseUrl: 'http://127.0.0.1:11434' });
  assert.equal(controller.power, 'ENGLAND');
  assert.throws(() => createPowerController({ power: 'ENGLAND', provider: 'ANTHROPIC', model: 'x' }), /not implemented/);
});
