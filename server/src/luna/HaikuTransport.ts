import Anthropic from '@anthropic-ai/sdk';
import { HAIKU_PRESET, buildHaikuRequest, haikuContextOf } from '../providers/HaikuPreset.js';
import type { LunaTransport } from './Transport.js';

/**
 * Sends one pinned Claude Haiku 5.5 request through the official SDK. As with the Luna transport, the
 * exact input is counted first with the token-counting endpoint (which creates no model response),
 * and the returned sender is bound to those bytes and usable once. The SDK's own retries are off:
 * a retry would be a second billed call that the ledger never reserved.
 * Paid operation remains interlocked at application startup.
 */
export function anthropicHaikuTransport(apiKey: string, fetchImpl?: typeof fetch): LunaTransport {
  if (typeof apiKey !== 'string' || apiKey.length < 8) throw new Error('A provider key is required.');
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: HAIKU_PRESET.timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const transport: LunaTransport = async () => { throw new Error('Haiku dispatch requires a successful input-token preflight.'); };
  transport.preflight = async ({ body, signal }) => {
    signal.throwIfAborted();
    // Reject settings/schema/model changes before either endpoint sees them.
    let params: Anthropic.MessageCreateParamsNonStreaming;
    try {
      if (body !== buildHaikuRequest({ context: haikuContextOf(body) }).body
        || Buffer.byteLength(body,'utf8') > HAIKU_PRESET.maxRequestBytes) throw new Error();
      params = JSON.parse(body) as Anthropic.MessageCreateParamsNonStreaming;
    } catch { throw new Error('Invalid Haiku request contract.'); }
    let tokens: unknown;
    try {
      // Every input-affecting field is counted, including the schema and the thinking setting.
      tokens = (await client.messages.countTokens({ model: params.model, system: params.system, messages: params.messages,
        thinking: params.thinking, output_config: params.output_config },{ signal, timeout: HAIKU_PRESET.countTimeoutMs })).input_tokens;
    } catch { throw new Error('Haiku input-token preflight unavailable.'); }
    if (!Number.isSafeInteger(tokens) || (tokens as number) < 1 || (tokens as number) > HAIKU_PRESET.maxInputTokens)
      throw new Error('Haiku input-token preflight exceeds its limit or is invalid.');
    signal.throwIfAborted();
    let used = false;
    const send: LunaTransport = async ({ body: exact, signal: sendSignal }) => {
      if (exact !== body || used) throw new Error('Haiku preflight does not authorize these bytes or a repeated dispatch.');
      sendSignal.throwIfAborted(); used = true;
      try {
        return { status: 200, body: await client.messages.create(params,{ signal: sendSignal }) };
      } catch (error) {
        // An HTTP error answer is recorded as such. Raw provider errors are never logged or stored.
        if (error instanceof Anthropic.APIError && typeof error.status === 'number') return { status: error.status, body: null };
        // No answer at all (connection failure, timeout, cancellation): the outcome is unknown.
        throw new Error('Haiku request did not complete.');
      }
    };
    return { inputTokens: tokens as number, send };
  };
  return transport;
}
