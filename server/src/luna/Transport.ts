import { LUNA_PRESET } from '../providers/LunaPreset.js';

/** Sends one already-serialized request. Must throw when no response was read; never retries. */
export type LunaTransport = (request: { body: string; signal: AbortSignal }) => Promise<{ status: number; body: unknown }>;

/**
 * The only code that talks to the provider. It is constructed nowhere at startup: paid operation is
 * still interlocked in configuration. The response is read with a hard size cap and never logged.
 */
export function httpLunaTransport(apiKey: string, request: typeof fetch = fetch): LunaTransport {
  if (typeof apiKey !== 'string' || apiKey.length < 8) throw new Error('A provider key is required.');
  return async ({ body, signal }) => {
    const response = await request(LUNA_PRESET.endpoint, { method: 'POST', signal, redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body });
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LUNA_PRESET.maxResponseBytes) { await reader.cancel().catch(() => {}); throw new Error('Provider response exceeds its size limit.'); }
      chunks.push(value);
    }
    let parsed: unknown = null;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* an unreadable body is normalized as an error with unknown billing */ }
    return { status: response.status, body: parsed };
  };
}

export interface MockOptions {
  /** Which listed number to take for each unit or slot: the first (hold/disband) or a seeded pseudo-random one. */
  pick?: 'first' | 'seeded';
  seed?: number;
}
/**
 * Deterministic stand-in for development and tests. It reads the numbered choices out of the request
 * exactly as a model would see them and answers in the provider's envelope, with usage derived from
 * the request size. It never touches the network and its "cost" is priced like a real answer so the
 * ledger is exercised honestly.
 */
export function mockLunaTransport(options: MockOptions = {}): LunaTransport {
  let serial = 0, state = (options.seed ?? 1) >>> 0;
  const random = () => { state = (Math.imul(state,1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  return async ({ body, signal }) => {
    signal.throwIfAborted();
    const text = String(JSON.parse(body).input[0].content[0].text), own = text.slice(text.lastIndexOf('\nYou are '));
    const groups: number[][] = [];
    for (const line of own.split('\n')) {
      if (/:$/.test(line)) groups.push([]);
      else { const match = /^(\d+) /.exec(line); if (match && groups.length) groups.at(-1)!.push(Number(match[1])); }
    }
    const upTo = /Pick up to (\d+)/.exec(own), exactly = /Pick exactly (\d+) numbers?: the unit/.exec(own);
    const choose = (list: number[]) => options.pick === 'seeded' ? list[Math.floor(random() * list.length)] : list[0];
    const choices = exactly ? groups.flat().slice(0,Number(exactly[1])) : upTo ? groups.slice(0,Number(upTo[1])).map(choose) : groups.filter(g => g.length).map(choose);
    const output = JSON.stringify({ choices }), input = Math.ceil(Buffer.byteLength(body) / 4), out = Math.ceil(output.length / 3) + 16;
    return { status: 200, body: { id: `resp_mock_${++serial}_${Date.now().toString(36)}`, model: LUNA_PRESET.model, service_tier: LUNA_PRESET.serviceTier, status: 'completed', error: null,
      usage: { input_tokens: input, output_tokens: out, total_tokens: input + out, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 16 } },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: output }] }] } };
  };
}
