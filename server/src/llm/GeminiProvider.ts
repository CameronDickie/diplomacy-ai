import type { LlmProvider, LlmProviderResult } from './PowerController.js';

interface GeminiResponse {
  output_text?: string;
  outputText?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usage_metadata?: {
    input_token_count?: number;
    output_token_count?: number;
    total_token_count?: number;
  };
  usageMetadata?: {
    inputTokenCount?: number;
    outputTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: {
    message?: string;
  };
}

export class GeminiProvider implements LlmProvider {
  readonly id = 'GEMINI';

  async completeJson<T>(request: {
    model: string;
    timeoutMs?: number;
    maxOutputTokens?: number;
    system: string;
    prompt: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<LlmProviderResult<T>> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        input: request.prompt,
        system_instruction: request.system,
        store: false,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: request.schema,
        },
        generation_config: {
          max_output_tokens: request.maxOutputTokens,
        },
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 90_000),
    });

    const payload = await response.json() as GeminiResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Gemini request failed (${response.status})`);
    }

    const text =
      payload.output_text ??
      payload.outputText ??
      payload.candidates
        ?.flatMap(candidate => candidate.content?.parts ?? [])
        .find(part => part.text)
        ?.text;
    if (!text) throw new Error('Gemini response did not contain structured output text');

    return {
      value: JSON.parse(text) as T,
      usage: {
        inputTokens:
          payload.usage_metadata?.input_token_count ??
          payload.usageMetadata?.inputTokenCount ??
          null,
        outputTokens:
          payload.usage_metadata?.output_token_count ??
          payload.usageMetadata?.outputTokenCount ??
          null,
      },
    };
  }
}
