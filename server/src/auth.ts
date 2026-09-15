import crypto, { scrypt } from 'crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'diplomacy_session';
const SCRYPT_OPTIONS = { cost: 16384, blockSize: 8, parallelization: 1 };

export interface AuthState {
  authenticated: boolean;
  enabled: boolean;
  message: string;
  status: number;
}

export function isAuthEnabled(): boolean {
  if (process.env.DIPLOMACY_AUTH_ENABLED === 'true') return true;
  if (process.env.DIPLOMACY_AUTH_ENABLED === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function isEnvConfigured(): boolean {
  return Boolean(
    process.env.DIPLOMACY_AUTH_USERNAME &&
      process.env.DIPLOMACY_AUTH_PASSWORD_SALT &&
      process.env.DIPLOMACY_AUTH_PASSWORD_HASH &&
      process.env.DIPLOMACY_AUTH_SESSION_SECRET
  );
}

function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.DIPLOMACY_AUTH_COOKIE_SECURE !== 'false';
}

function readCookieFromHeader(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function verifySessionValue(sessionValue: string | null): AuthState {
  if (!isAuthEnabled()) {
    return { authenticated: true, enabled: false, message: 'authentication disabled', status: 200 };
  }
  if (!isEnvConfigured()) {
    return { authenticated: false, enabled: true, message: 'Authentication environment not configured', status: 500 };
  }
  if (!sessionValue) {
    return { authenticated: false, enabled: true, message: 'No session cookie provided', status: 401 };
  }

  const [payload, signature] = sessionValue.split('.');
  if (!payload || !signature) {
    return { authenticated: false, enabled: true, message: 'Invalid session format', status: 401 };
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.DIPLOMACY_AUTH_SESSION_SECRET!)
    .update(payload)
    .digest('base64url');
  const validSignature =
    Buffer.byteLength(signature) === Buffer.byteLength(expectedSignature) &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  if (!validSignature) {
    return { authenticated: false, enabled: true, message: 'Session is invalid', status: 401 };
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (session.sub !== 'diplomacy' || typeof session.exp !== 'number' || Date.now() > session.exp) {
      return { authenticated: false, enabled: true, message: 'Session has expired', status: 401 };
    }
    return { authenticated: true, enabled: true, message: 'success', status: 200 };
  } catch {
    return { authenticated: false, enabled: true, message: 'Could not parse session', status: 401 };
  }
}

export function verifyAuthRequest(request: Request): AuthState {
  return verifySessionValue(readCookieFromHeader(request.headers.cookie, COOKIE_NAME));
}

export function verifyAuthCookieHeader(cookieHeader: string | undefined): AuthState {
  return verifySessionValue(readCookieFromHeader(cookieHeader, COOKIE_NAME));
}

export const requireSiteAuth: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction
) => {
  const state = verifyAuthRequest(request);
  if (!state.authenticated) {
    response.status(state.status).json({ message: state.message, authenticated: false });
    return;
  }
  next();
};

export function createAuthRouter(): express.Router {
  const router = express.Router();

  router.get('/session', (request, response) => {
    const state = verifyAuthRequest(request);
    response.status(state.status).json(state);
  });

  router.post('/login', (request, response) => {
    if (!isAuthEnabled()) {
      response.status(200).json({ success: true, authenticated: true, enabled: false });
      return;
    }
    if (!isEnvConfigured()) {
      response.status(500).json({ message: 'Authentication environment not configured' });
      return;
    }

    const loginAttempt = (request.body ?? {}) as { username?: unknown; password?: unknown };
    if (
      typeof loginAttempt.username !== 'string' ||
      typeof loginAttempt.password !== 'string' ||
      !loginAttempt.username.trim()
    ) {
      response.status(400).json({ message: 'Invalid login credentials' });
      return;
    }

    if (loginAttempt.username !== process.env.DIPLOMACY_AUTH_USERNAME) {
      response.status(400).json({ message: 'Invalid login credentials' });
      return;
    }

    const storedSalt = Buffer.from(process.env.DIPLOMACY_AUTH_PASSWORD_SALT!, 'hex');
    const storedHash = Buffer.from(process.env.DIPLOMACY_AUTH_PASSWORD_HASH!, 'hex');
    scrypt(loginAttempt.password, storedSalt, storedHash.length, SCRYPT_OPTIONS, (error, attemptedHash) => {
      if (error) {
        response.status(500).json({ message: 'Unable to verify credentials' });
        return;
      }

      const passwordMatches =
        storedHash.length === attemptedHash.length &&
        crypto.timingSafeEqual(attemptedHash, storedHash);
      if (!passwordMatches) {
        response.status(400).json({ message: 'Invalid login credentials' });
        return;
      }

      const payload = Buffer.from(JSON.stringify({
        sub: 'diplomacy',
        exp: Date.now() + SESSION_TTL_MS,
      })).toString('base64url');
      const signature = crypto
        .createHmac('sha256', process.env.DIPLOMACY_AUTH_SESSION_SECRET!)
        .update(payload)
        .digest('base64url');

      response.cookie(COOKIE_NAME, `${payload}.${signature}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure(),
        path: '/',
        maxAge: SESSION_TTL_MS,
      });
      response.status(200).json({ success: true, authenticated: true, enabled: true });
    });
  });

  router.post('/logout', (_request, response) => {
    response.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure(),
      path: '/',
    });
    response.status(204).send();
  });

  return router;
}
