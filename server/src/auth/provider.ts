import { createHash } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

export type Provider = 'github' | 'google';
export interface Credentials { clientId: string; clientSecret: string }
export interface OAuthRequest { provider: Provider; verifier: string; nonce: string; callback: string }
export interface Identity { provider: Provider; subject: string; displayName: string }
export type Fetch = typeof globalThis.fetch;
const MAX_RESPONSE_BYTES = 64 * 1024;
const endpoints = {
  github: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token' },
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
};
export function authorizationUrl(request: OAuthRequest, clientId: string, state: string): string {
  const url = new URL(endpoints[request.provider].authorize);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: request.callback, response_type: 'code', state,
    scope: request.provider === 'github' ? 'read:user' : 'openid profile email',
    code_challenge: createHash('sha256').update(request.verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(request.provider === 'google' ? { nonce: request.nonce, access_type: 'online' } : {}),
  }).toString();
  return url.href;
}

/** Size, deadline and redirects are bounded even for a stalled or malformed provider. */
export async function boundedFetch(fetcher: Fetch, url: string | URL, init: RequestInit): Promise<Response> {
  const response = await fetcher(url, { ...init, redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel(); throw new Error('OAuth provider unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OAuth provider returned no body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('OAuth provider response too large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'content-type': 'application/json' } });
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response');
  return value as Record<string, unknown>;
};
const displayName = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100) || fallback : fallback;

export class OAuthProvider {
  private readonly keys;
  constructor(private readonly fetcher: Fetch = fetch) {
    this.keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
      timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
      [customFetch]: (url, init) => boundedFetch(fetcher, url, init),
    });
  }
  async exchange(request: OAuthRequest, credentials: Credentials, code: string, now: number): Promise<Identity> {
    const signal = AbortSignal.timeout(10_000);
    const tokenResponse = await boundedFetch(this.fetcher, endpoints[request.provider].token, {
      method: 'POST', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
        code, redirect_uri: request.callback, grant_type: 'authorization_code', code_verifier: request.verifier }),
    });
    const tokens = object(await tokenResponse.json());
    if (tokens.error) throw new Error('Provider rejected login');
    if (request.provider === 'google') {
      if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16000) throw new Error('Missing ID token');
      const { payload } = await jwtVerify(tokens.id_token, this.keys, {
        algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: credentials.clientId, requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
        maxTokenAge: '10 minutes', currentDate: new Date(now), clockTolerance: 5,
      });
      if (payload.nonce !== request.nonce || (payload.azp !== undefined && payload.azp !== credentials.clientId) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== credentials.clientId) ||
          !payload.sub || !/^[\x21-\x7e]{1,255}$/.test(payload.sub)) throw new Error('Invalid ID token');
      return { provider: 'google', subject: payload.sub, displayName: displayName(payload.name, 'Google player') };
    }
    if (typeof tokens.access_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(tokens.access_token) ||
        typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer') throw new Error('Invalid access token');
    const user = object(await (await boundedFetch(this.fetcher, 'https://api.github.com/user', {
      signal, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'diplomacy-ai' },
    })).json());
    if (!Number.isSafeInteger(user.id) || (user.id as number) <= 0) throw new Error('Invalid GitHub identity');
    return { provider: 'github', subject: String(user.id), displayName: displayName(user.login, 'GitHub player') };
  }
}
