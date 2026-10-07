import { readLlmConfig } from '../../../config/runtime.cjs';
import { OllamaProvider } from './OllamaProvider.js';

/**
 * One structured request against the configured Ollama server, to confirm a model is installed,
 * follows a JSON schema and answers within the server's request timeout. Usage:
 *   npm run ollama:smoke -- [model]
 */
async function main(): Promise<void> {
  const config = readLlmConfig();
  const model = process.argv[2] ?? config.defaultModels.OLLAMA?.ORDERS ?? config.allowedModels.OLLAMA[0];
  if (!model) throw new Error('Name a model: npm run ollama:smoke -- <model>, or set LLM_ALLOWED_MODELS_OLLAMA');
  const provider = new OllamaProvider(config.ollamaBaseUrl);
  console.log(`Asking ${model} at ${config.ollamaBaseUrl} (timeout ${config.requestTimeoutMs} ms)…`);
  const started = Date.now();
  const result = await provider.completeJson<{ power: string; orderIds: string[] }>({
    model,
    timeoutMs: config.requestTimeoutMs,
    maxOutputTokens: 256,
    system: 'You play ENGLAND in Diplomacy. Answer only with the JSON object requested.',
    prompt: 'Legal order IDs: "LON|HOLD", "LON|MOVE|NTH", "EDI|HOLD", "LVP|HOLD". Choose exactly one order for each of LON, EDI and LVP.',
    schemaName: 'smoke_orders',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['power', 'orderIds'],
      properties: {
        power: { type: 'string', enum: ['ENGLAND'] },
        orderIds: { type: 'array', items: { type: 'string', enum: ['LON|HOLD', 'LON|MOVE|NTH', 'EDI|HOLD', 'LVP|HOLD'] } },
      },
    },
  });
  const ms = Date.now() - started;
  if (result.value.power !== 'ENGLAND' || !Array.isArray(result.value.orderIds) || !result.value.orderIds.length) {
    throw new Error(`${model} answered, but not in the requested shape: ${JSON.stringify(result.value)}`);
  }
  console.log(`OK in ${ms} ms: ${JSON.stringify(result.value)}`);
  console.log(`Tokens: ${result.usage.inputTokens ?? '?'} in, ${result.usage.outputTokens ?? '?'} out.`);
  if (ms > config.requestTimeoutMs / 2) console.log('This is slow for seven powers a phase; consider a smaller model or a longer LLM_REQUEST_TIMEOUT_MS.');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
