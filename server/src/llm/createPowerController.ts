import type { LlmProviderId, Power } from '@diplomacy/shared';
import { OpenAIProvider } from './OpenAIProvider.js';
import type { PowerController } from './PowerController.js';
import { StructuredLlmController } from './StructuredLlmController.js';
import { StubLlmController } from './StubLlmController.js';

export function createPowerController(options: {
  power: Power;
  provider: LlmProviderId;
  model: string;
}): PowerController {
  if (options.provider === 'STUB') return new StubLlmController(options.power);
  if (options.provider === 'OPENAI') {
    return new StructuredLlmController(
      options.power,
      options.model,
      new OpenAIProvider()
    );
  }
  throw new Error(`${options.provider} provider adapter is not implemented`);
}
