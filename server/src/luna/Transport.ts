import { createHash } from 'node:crypto';
import { EFFORTS, LUNA_REQUESTS, type FullGameRequestKind, type OpenAiRequests } from '../providers/LunaPreset.js';
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
/**
 * What is safe to say about a request that got no usable answer: the system's short code
 * (ECONNRESET, ENOTFOUND, UND_ERR_SOCKET…) when there is one, otherwise the kind of error. Never a message.
 */
export function networkCode(error: unknown): string {
  type Coded = { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
  const seen: Coded[] = [];
  // fetch wraps the real failure in `cause`; trying several addresses wraps one failure per address in `errors`.
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    const e = value as Coded; seen.push(e); walk(e.cause,depth + 1);
    if (Array.isArray(e.errors)) for (const inner of e.errors.slice(0,4)) walk(inner,depth + 1);
  };
  walk(error,0);
  const safe = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{2,40}$/.test(v);
  const codes = [...new Set(seen.map(e => e.code).filter(safe))];
  if (codes.length) return `, ${codes.join('/')}`;
  const name = seen.map(e => e.name).filter(safe).at(-1);
  return name ? `, ${name}` : '';
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
      if (size > maxBytes) throw Object.assign(new Error('Provider response exceeds its size limit.'),{ name: 'ResponseTooLarge' });
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
export function httpLunaTransport(apiKey: string, request: typeof fetch = fetch): LunaTransport { return httpOpenAiTransport(apiKey,request,LUNA_REQUESTS,'Luna'); }
/** The same for any pinned OpenAI model: only its own pinned request bodies are counted and sent. */
export function httpOpenAiTransport(apiKey: string, request: typeof fetch, requests: OpenAiRequests, name: string): LunaTransport {
  const preset = requests.preset;
  if (typeof apiKey !== 'string' || apiKey.length < 8) throw new Error('A provider key is required.');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const transport: LunaTransport = async () => { throw new Error(`${name} HTTP dispatch requires a successful input-token preflight.`); };
  transport.preflight = async ({ body, signal }) => {
    signal.throwIfAborted();
    // Reject settings/schema/model changes before either endpoint sees them.
    let parsed: ReturnType<typeof JSON.parse>;
    try {
      parsed = JSON.parse(body);
      const context = { context: parsed.input[0].content[0].text };
      if (!requests.requestBodies(context).includes(body)
        || Buffer.byteLength(body,'utf8') > preset.maxRequestBytes) throw new Error();
    } catch { throw new Error(`Invalid ${name} request contract.`); }
    const countBody = JSON.stringify({ model: parsed.model, input: parsed.input, instructions: parsed.instructions,
      reasoning: parsed.reasoning, text: parsed.text, tools: parsed.tools, tool_choice: parsed.tool_choice, truncation: parsed.truncation });
    const deadline = AbortSignal.any([signal,AbortSignal.timeout(preset.countTimeoutMs)]);
    let count: unknown;
    try {
      count = await abortable((async () => {
        const response = await request(preset.countEndpoint,{ method: 'POST', signal: deadline, redirect: 'error', headers, body: countBody });
        // The status first: an error page can be larger than a count, and must not be mistaken for a lost connection.
        if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new PreflightError('',`HTTP ${response.status}`); }
        return await readJson(response,preset.maxCountResponseBytes);
      })(),deadline);
    } catch (error) {
      throw new PreflightError(`${name} input-token preflight unavailable.`,error instanceof PreflightError ? error.detail : signal.aborted ? 'cancelled' : deadline.aborted ? 'no answer in time' : `no connection${networkCode(error)}`);
    }
    const tokens = (count as { input_tokens?: unknown } | null)?.input_tokens;
    if (!count || typeof count !== 'object' || Array.isArray(count) || Object.keys(count).sort().join(',') !== 'input_tokens,object'
      || (count as { object?: unknown }).object !== 'response.input_tokens'
      || !Number.isSafeInteger(tokens) || (tokens as number) < 1 || (tokens as number) > preset.maxInputTokens)
      throw new PreflightError(`${name} input-token preflight exceeds its limit or is invalid.`,'count over the limit or malformed');
    signal.throwIfAborted();
    let used = false;
    const send: LunaTransport = async ({ body: exact, signal: sendSignal }) => {
      if (exact !== body || used) throw new Error(`${name} preflight does not authorize these bytes or a repeated dispatch.`);
      sendSignal.throwIfAborted(); used = true;
      const response = await request(preset.endpoint,{ method: 'POST', signal: sendSignal, redirect: 'error', headers, body });
      return { status: response.status, body: await readJson(response,preset.maxResponseBytes) };
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
    // A full game may be played at any reasoning effort; the stand-in answers the same way at each.
    const isKind = (kind: FullGameRequestKind) => EFFORTS.some(effort => body === contract.buildFullGameRequest({ context: text },kind,effort).body);
    for (const kind of ['ASK','REPLY'] as const) if (isKind(kind)) {
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
    // A full game's orders are answered unit by unit, naming each heading beside its number.
    const keyed = isKind('UNIT_ORDERS');
    const headings = own.split('\n').filter(line => /:$/.test(line)).map(line => line.slice(0,-1).replace(/^[AF] /,'').split('/')[0]);
    const output = JSON.stringify(keyed ? { orders: choices.map((choice,i) => ({ unit: headings[i], choice })), note: `(stand-in, no model was asked) ${/\nYou are ([A-Z]+)\./.exec(text)?.[1] ?? 'This power'} wrote this note.` } : { choices }), input = Math.ceil(Buffer.byteLength(body) / 4), out = Math.ceil(output.length / 3) + 16;
    return { status: 200, body: contract.mockEnvelope({ serial: ++serial, text: output, inputTokens: input, outputTokens: out }) };
  };
}
