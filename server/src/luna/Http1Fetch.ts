import http from 'node:http';
import https from 'node:https';

const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * A minimal `fetch` over Node's own HTTP/1.1 client, for the command-line tools' provider calls.
 *
 * The built-in `fetch` may speak HTTP/2 on one shared connection. In long unattended games the
 * largest requests began failing at once, every time, for minutes, while small requests on the same
 * connection and fresh processes kept working, and the failure carried no system code to name it.
 * Here every call opens its own connection, so nothing is shared between calls that could go wrong
 * and stay wrong, and no paid request is ever written to a connection the provider has already
 * closed. An unexpected status (a redirect included) comes back as that status. The cost is one
 * handshake per call, which an unattended game does not notice.
 *
 * Only what those calls use is supported: a string or byte body, an abort signal, no redirects
 * followed, no compression asked for, and a bounded response.
 */
export const http1Fetch: typeof fetch = (input, init) => new Promise<Response>((resolve, reject) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') { reject(new TypeError('Unsupported URL scheme.')); return; }
  const body = init?.body, signal = init?.signal ?? undefined;
  if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) { reject(new TypeError('Unsupported request body.')); return; }
  if (signal?.aborted) { reject(signal.reason); return; }
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
  // Answers are read as they arrive; nothing here decompresses.
  headers['accept-encoding'] = 'identity';
  const bytes = body == null ? null : Buffer.from(body as string | Uint8Array);
  if (bytes) headers['content-length'] = String(bytes.byteLength);
  const request = (url.protocol === 'https:' ? https : http).request(url,{ method: init?.method ?? 'GET', headers, agent: false },response => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data',(chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) request.destroy(Object.assign(new Error('Provider response exceeds its size limit.'),{ name: 'ResponseTooLarge' }));
      else chunks.push(chunk);
    });
    response.on('error',fail);
    response.on('end',() => {
      const status = response.statusCode ?? 0, answer = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) answer.set(name,Array.isArray(value) ? value.join(', ') : value);
      done(() => resolve(new Response([101,204,205,304].includes(status) ? null : Buffer.concat(chunks),{ status, headers: answer })));
    });
  });
  const onAbort = () => request.destroy(signal!.reason instanceof Error ? signal!.reason : new DOMException('This operation was aborted','AbortError'));
  let settled = false;
  const done = (settle: () => void) => { if (settled) return; settled = true; signal?.removeEventListener('abort',onAbort); settle(); };
  function fail(error: Error) { done(() => reject(error)); }
  request.on('error',fail);
  signal?.addEventListener('abort',onAbort,{ once: true });
  request.end(bytes ?? undefined);
});
