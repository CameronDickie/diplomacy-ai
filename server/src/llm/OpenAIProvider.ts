import type { LlmProvider, LlmProviderResult } from './PowerController.js';

interface OpenAIResponse {
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export class OpenAIProvider implements LlmProvider {
  readonly id = 'OPENAI';

  async completeJson<T>(request: {
    model: string;
    system: string;
    prompt: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<LlmProviderResult<T>> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        instructions: request.system,
        input: request.prompt,
        text: {
          format: {
            type: 'json_schema',
            name: request.schemaName,
            strict: true,
            schema: request.schema,
          },
        },
      }),
      signal: AbortSignal.timeout(90_000),
    });

    const payload = await response.json() as OpenAIResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `OpenAI request failed (${response.status})`);
    }

    const text = payload.output
      ?.flatMap(item => item.content ?? [])
      .find(item => item.type === 'output_text')
      ?.text;
    if (!text) throw new Error('OpenAI response did not contain structured output text');

    return {
      value: JSON.parse(text) as T,
      usage: {
        inputTokens: payload.usage?.input_tokens ?? null,
        outputTokens: payload.usage?.output_tokens ?? null,
      },
    };
  }
}
