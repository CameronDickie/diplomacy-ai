import type { LlmProvider, LlmProviderResult } from './PowerController.js';

interface OllamaChatResponse {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const MAX_RESPONSE_BYTES = 1_048_576;

/** A setup or capability problem the owner can fix; the message says how. */
export class OllamaSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaSetupError';
  }
}

/**
 * Local inference through an Ollama server the owner runs. The endpoint comes from server
 * configuration only (`OLLAMA_BASE_URL`); nothing a player sends can choose where requests go.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = 'OLLAMA';
  /** One capability check per model for the life of the process; a failed check is retried next time. */
  private readonly checked = new Map<string, Promise<void>>();

  constructor(private readonly baseUrl: string) {}

  async completeJson<T>(request: {
    model: string;
    timeoutMs?: number;
    maxOutputTokens?: number;
    system: string;
    prompt: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<LlmProviderResult<T>> {
    // Local models are slow to load; the one deadline covers the capability check and the answer.
    const signal = AbortSignal.timeout(request.timeoutMs ?? 90_000);
    await this.ensureUsable(request.model, signal);

    const payload = await this.post<OllamaChatResponse>('/api/chat', {
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      stream: false,
      format: request.schema,
      options: { temperature: 0, num_predict: request.maxOutputTokens },
    }, signal, request.model);

    if (payload.done_reason === 'length') {
      throw new Error(`Ollama model ${request.model} ran out of output tokens before finishing its answer`);
    }
    const text = payload.message?.content;
    if (!text) throw new Error(`Ollama model ${request.model} returned no content`);
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      // Older servers and some models ignore `format`; say so instead of failing later on a missing field.
      throw new OllamaSetupError(
        `Ollama model ${request.model} did not return JSON for ${request.schemaName}. ` +
        'Structured output needs Ollama 0.5 or newer and a model that follows a JSON schema.'
      );
    }
    return {
      value,
      usage: {
        inputTokens: payload.prompt_eval_count ?? null,
        outputTokens: payload.eval_count ?? null,
      },
    };
  }

  private ensureUsable(model: string, signal: AbortSignal): Promise<void> {
    let check = this.checked.get(model);
    if (!check) {
      check = this.inspect(model, signal);
      this.checked.set(model, check);
      check.catch(() => this.checked.delete(model));
    }
    return check;
  }

  private async inspect(model: string, signal: AbortSignal): Promise<void> {
    const shown = await this.post<{ capabilities?: unknown }>('/api/show', { model }, signal, model);
    // Older servers do not report capabilities; an embedding-only model on a newer one cannot play.
    if (Array.isArray(shown.capabilities) && !shown.capabilities.includes('completion')) {
      throw new OllamaSetupError(`Ollama model ${model} cannot generate text (it reports: ${shown.capabilities.join(', ') || 'no capabilities'})`);
    }
  }

  private async post<R>(path: string, body: unknown, signal: AbortSignal, model: string): Promise<R> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new Error(`Ollama model ${model} did not answer in time; a smaller model or a longer LLM_REQUEST_TIMEOUT_MS may help`);
      throw new OllamaSetupError(
        `Ollama is not reachable at ${this.baseUrl} (${error instanceof Error ? error.message : 'request failed'}). ` +
        'Start it with `ollama serve`, or set OLLAMA_BASE_URL.'
      );
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('Ollama response was too large');
    let payload: R & { error?: string };
    try {
      payload = JSON.parse(text) as R & { error?: string };
    } catch {
      throw new OllamaSetupError(`${this.baseUrl} did not answer like an Ollama server (HTTP ${response.status})`);
    }
    if (response.status === 404) {
      throw new OllamaSetupError(`Ollama model ${model} is not installed. Run \`ollama pull ${model}\` on the server.`);
    }
    if (!response.ok) throw new Error(payload.error ?? `Ollama request failed (${response.status})`);
    return payload;
  }
}
