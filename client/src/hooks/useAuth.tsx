import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type AuthStatus = 'CHECKING' | 'AUTHENTICATED' | 'LOGIN' | 'ERROR';

interface SessionResponse {
  authenticated?: boolean;
  enabled?: boolean;
  message?: string;
}

interface AuthContextValue {
  authenticated: boolean;
  enabled: boolean;
  message: string | null;
  status: AuthStatus;
  submitting: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const apiBase = import.meta.env.VITE_SERVER_URL || '';
const AUTH_CHANGED_EVENT = 'diplomacy-auth-changed';

async function requestSession(): Promise<SessionResponse> {
  const response = await fetch(`${apiBase}/api/auth/session`, {
    credentials: 'include',
  });
  const payload = await response.json().catch(() => ({})) as SessionResponse;
  if (!response.ok && response.status >= 500) {
    throw new Error(payload.message ?? 'Authentication check failed');
  }
  return payload;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('CHECKING');
  const [enabled, setEnabled] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const session = await requestSession();
      setEnabled(session.enabled ?? true);
      setStatus(session.authenticated ? 'AUTHENTICATED' : 'LOGIN');
      setMessage(session.authenticated ? null : session.message ?? null);
    } catch (error) {
      setStatus('ERROR');
      setMessage(error instanceof Error ? error.message : 'Authentication check failed');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function login(username: string, password: string): Promise<boolean> {
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json().catch(() => ({})) as SessionResponse;
      setEnabled(payload.enabled ?? true);
      if (!response.ok || !payload.authenticated) {
        setMessage(payload.message ?? 'Invalid login credentials');
        setStatus('LOGIN');
        return false;
      }
      setStatus('AUTHENTICATED');
      window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Login failed');
      setStatus('ERROR');
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function logout(): Promise<void> {
    await fetch(`${apiBase}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => undefined);
    setStatus(enabled ? 'LOGIN' : 'AUTHENTICATED');
    setMessage(null);
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  }

  const value = useMemo<AuthContextValue>(() => ({
    authenticated: status === 'AUTHENTICATED',
    enabled,
    login,
    logout,
    message,
    refresh,
    status,
    submitting,
  }), [enabled, message, status, submitting]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
