import { createHash } from 'node:crypto';
import { LUNA_PRESET, lunaRequestBodies } from '../providers/LunaPreset.js';
import { LUNA_CONTRACT, type OpponentContract } from '../providers/OpponentContract.js';

export interface LunaResponse { status: number; body: unknown }
/** Sends one already-serialized request. No retries. Plain transports are local test doubles. */
export type LunaTransport = ((request: { body: string; signal: AbortSignal }) => Promise<LunaResponse>) & {
  /** HTTP transport must count the exact input first. The returned sender is bound to those bytes and usable once. */
  preflight?: (request: { body: string; signal: AbortSignal }) => Promise<{ inputTokens: number; send: LunaTransport }>;
};

/**
 * A token count that could not be obtained, so nothing was sent or billed. `detail` is a category
 * safe to log: an HTTP status, a timeout, or a malformed count. Never a provider's error text.
 */
export class PreflightError extends Error {
  constructor(message: string, readonly detail: string) { super(message); this.name = 'PreflightError'; }
}
/** Read a bounded body. Raw errors and bodies are never logged. */
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Provider response exceeds its size limit.');
      chunks.push(value);
    }
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

/** A counter or reader that ignores cancellation must not hold a phase indefinitely. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // Always attach to work, even when fetch synchronously aborted the signal before returning it.
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_,reject) => {
    onAbort = () => reject(new Error('Luna preflight cancelled.'));
    signal.addEventListener('abort',onAbort,{once:true});
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([work,aborted]); }
  finally { signal.removeEventListener('abort',onAbort); }
}

/**
 * Uses the official input-token endpoint with every input-affecting field, including the schema.
 * It never creates a model response during preflight. Reserve the full preset ceiling before
 * preflight; take the durable dispatch claim afterwards so stop/ban/funding are checked again.
 * Paid operation remains interlocked at application startup.
 */
export function httpLunaTransport(apiKey: string, request: typeof fetch = fetch): LunaTransport {
  if (typeof apiKey !== 'string' || apiKey.length < 8) throw new Error('A provider key is required.');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const transport: LunaTransport = async () => { throw new Error('Luna HTTP dispatch requires a successful input-token preflight.'); };
  transport.preflight = async ({ body, signal }) => {
    signal.throwIfAborted();
    // Reject settings/schema/model changes before either endpoint sees them.
    let parsed: ReturnType<typeof JSON.parse>;
    try {
      parsed = JSON.parse(body);
      const context = { context: parsed.input[0].content[0].text };
      if (!lunaRequestBodies(context).includes(body)
        || Buffer.byteLength(body,'utf8') > LUNA_PRESET.maxRequestBytes) throw new Error();
    } catch { throw new Error('Invalid Luna request contract.'); }
    const countBody = JSON.stringify({ model: parsed.model, input: parsed.input, instructions: parsed.instructions,
      reasoning: parsed.reasoning, text: parsed.text, tools: parsed.tools, tool_choice: parsed.tool_choice, truncation: parsed.truncation });
    const deadline = AbortSignal.any([signal,AbortSignal.timeout(LUNA_PRESET.countTimeoutMs)]);
    let count: unknown;
    try {
      count = await abortable((async () => {
        const response = await request(LUNA_PRESET.countEndpoint,{ method: 'POST', signal: deadline, redirect: 'error', headers, body: countBody });
        const value = await readJson(response,LUNA_PRESET.maxCountResponseBytes);
        if (response.status !== 200) throw new PreflightError('',`HTTP ${response.status}`);
        return value;
      })(),deadline);
    } catch (error) {
      throw new PreflightError('Luna input-token preflight unavailable.',error instanceof PreflightError ? error.detail : signal.aborted ? 'cancelled' : deadline.aborted ? 'no answer in time' : 'no connection');
    }
    const tokens = (count as { input_tokens?: unknown } | null)?.input_tokens;
    if (!count || typeof count !== 'object' || Array.isArray(count) || Object.keys(count).sort().join(',') !== 'input_tokens,object'
      || (count as { object?: unknown }).object !== 'response.input_tokens'
      || !Number.isSafeInteger(tokens) || (tokens as number) < 1 || (tokens as number) > LUNA_PRESET.maxInputTokens)
      throw new PreflightError('Luna input-token preflight exceeds its limit or is invalid.','count over the limit or malformed');
    signal.throwIfAborted();
    let used = false;
    const send: LunaTransport = async ({ body: exact, signal: sendSignal }) => {
      if (exact !== body || used) throw new Error('Luna preflight does not authorize these bytes or a repeated dispatch.');
      sendSignal.throwIfAborted(); used = true;
      const response = await request(LUNA_PRESET.endpoint,{ method: 'POST', signal: sendSignal, redirect: 'error', headers, body });
      return { status: response.status, body: await readJson(response,LUNA_PRESET.maxResponseBytes) };
    };
    return { inputTokens: tokens as number, send };
  };
  return transport;
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
export function mockLunaTransport(options: MockOptions = {}): LunaTransport { return mockOpponentTransport(LUNA_CONTRACT,options); }
/** The same stand-in for any preset: it reads that preset's request and answers in that provider's envelope. */
export function mockOpponentTransport(contract: OpponentContract, options: MockOptions = {}): LunaTransport {
  let serial = 0;
  return async ({ body, signal }) => {
    signal.throwIfAborted();
    // Request-local randomness makes seeded choices independent of worker completion order.
    let state=createHash('sha256').update(String((options.seed??1)>>>0)).update(body).digest().readUInt32BE(0);
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
    const text = contract.contextOf(body);
    if (body === contract.buildChatRequest({ context: text }).body) {
      const speaker = /\nYou are ([A-Z]+)\./.exec(text)?.[1] ?? 'This power', reply = JSON.stringify({ reply: `(stand-in reply, no model was asked) ${speaker} has read your message.` });
      return { status: 200, body: contract.mockEnvelope({ serial: ++serial, text: reply, inputTokens: Math.ceil(Buffer.byteLength(body) / 4), outputTokens: Math.ceil(reply.length / 3) + 16 }) };
    }
    for (const kind of ['ASK','REPLY'] as const) if (body === contract.buildFullGameRequest({ context: text },kind).body) {
      // A stand-in diplomat: it writes to the first powers it may (or a seeded few), and answers everyone who wrote.
      const speaker = /\nYou are ([A-Z]+)\./.exec(text)?.[1] ?? 'This power';
      const line = kind === 'ASK' ? /\nYou may write to up to (\d+) of: ([A-Z, ]+)\./.exec(text) : /\nReply to: ([A-Z, ]+)\./.exec(text);
      const names = (line?.at(-1) ?? '').split(', ').filter(Boolean), count = kind === 'ASK' ? Math.min(Number(line?.[1] ?? 0),options.pick === 'seeded' ? 1 + Math.floor(random() * 3) : 2) : names.length;
      const picked = options.pick === 'seeded' && kind === 'ASK' ? [...names].sort(() => random() - 0.5).slice(0,count) : names.slice(0,count);
      const answer = JSON.stringify({ messages: picked.map(to => ({ to, text: `(stand-in, no model was asked) ${speaker} ${kind === 'ASK' ? 'asks what' : 'has read the message from'} ${to}${kind === 'ASK' ? ' intends this turn.' : '.'}` })) });
      return { status: 200, body: contract.mockEnvelope({ serial: ++serial, text: answer, inputTokens: Math.ceil(Buffer.byteLength(body) / 4), outputTokens: Math.ceil(answer.length / 3) + 16 }) };
    }
    // Choices begin at the rule line; a conversation shown before it is not a list of choices.
    const section = text.slice(text.lastIndexOf('\nYou are ')), own = section.slice(Math.max(0,section.search(/\nPick /)));
    const groups: number[][] = [], holds = new Set<number>();
    for (const line of own.split('\n')) {
      if (/:$/.test(line)) groups.push([]);
      else { const match = /^(\d+) (.*)$/.exec(line); if (match && groups.length) { groups.at(-1)!.push(Number(match[1])); if (/ holds$/.test(match[2])) holds.add(Number(match[1])); } }
    }
    const upTo = /Pick up to (\d+)/.exec(own), exactly = /Pick exactly (\d+) numbers?: the unit/.exec(own);
    // The quiet default is each unit's hold, wherever it is listed.
    const choose = (list: number[]) => options.pick === 'seeded' ? list[Math.floor(random() * list.length)] : list.find(n => holds.has(n)) ?? list[0];
    const choices = exactly ? groups.flat().slice(0,Number(exactly[1])) : upTo ? groups.slice(0,Number(upTo[1])).map(choose) : groups.filter(g => g.length).map(choose);
    const output = JSON.stringify({ choices }), input = Math.ceil(Buffer.byteLength(body) / 4), out = Math.ceil(output.length / 3) + 16;
    return { status: 200, body: contract.mockEnvelope({ serial: ++serial, text: output, inputTokens: input, outputTokens: out }) };
  };
}
