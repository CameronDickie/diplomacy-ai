import { PRACTICE_BOT_MODEL, PracticeBotController } from './PracticeBotController.js';
import type { LlmProviderId, Power } from '@diplomacy/shared';
import { readLlmConfig } from '../../../config/runtime.cjs';
import { GeminiProvider } from './GeminiProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import type { PowerController } from './PowerController.js';
import { StructuredLlmController } from './StructuredLlmController.js';
import { StubLlmController } from './StubLlmController.js';

// One adapter per endpoint, so its per-model capability check runs once rather than once per power.
const ollama = new Map<string, OllamaProvider>();

export function createPowerController(options: {
  power: Power;
  provider: LlmProviderId;
  model: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Server configuration only; defaults to the validated OLLAMA_BASE_URL. */
  ollamaBaseUrl?: string;
}): PowerController {
  if (options.provider === 'STUB') return options.model === PRACTICE_BOT_MODEL ? new PracticeBotController(options.power) : new StubLlmController(options.power);
  if (options.provider === 'OPENAI') {
    return new StructuredLlmController(
      options.power,
      options.model,
      new OpenAIProvider(),
      {
        timeoutMs: options.timeoutMs,
        maxOutputTokens: options.maxOutputTokens,
      }
    );
  }
  if (options.provider === 'GEMINI') {
    return new StructuredLlmController(
      options.power,
      options.model,
      new GeminiProvider(),
      {
        timeoutMs: options.timeoutMs,
        maxOutputTokens: options.maxOutputTokens,
      }
    );
  }
  if (options.provider === 'OLLAMA') {
    const baseUrl = options.ollamaBaseUrl ?? readLlmConfig().ollamaBaseUrl;
    let provider = ollama.get(baseUrl);
    if (!provider) ollama.set(baseUrl, provider = new OllamaProvider(baseUrl));
    return new StructuredLlmController(
      options.power,
      options.model,
      provider,
      {
        timeoutMs: options.timeoutMs,
        maxOutputTokens: options.maxOutputTokens,
      }
    );
  }
  throw new Error(`${options.provider} provider adapter is not implemented`);
}
