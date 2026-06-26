import type { LlmProviderId, Power } from '@diplomacy/shared';
import { GeminiProvider } from './GeminiProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import type { PowerController } from './PowerController.js';
import { StructuredLlmController } from './StructuredLlmController.js';
import { StubLlmController } from './StubLlmController.js';

export function createPowerController(options: {
  power: Power;
  provider: LlmProviderId;
  model: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}): PowerController {
  if (options.provider === 'STUB') return new StubLlmController(options.power);
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
  throw new Error(`${options.provider} provider adapter is not implemented`);
}
