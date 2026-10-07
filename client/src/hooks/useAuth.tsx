import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PlayerSession } from '@diplomacy/shared';

type AuthStatus = 'CHECKING' | 'AUTHENTICATED' | 'LOGIN' | 'ERROR';
export interface AuthContextValue extends PlayerSession {
  message: string | null;
  status: AuthStatus;
  submitting: boolean;
  loginUrl: (provider: 'github' | 'google') => string;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
const apiBase = import.meta.env.VITE_SERVER_URL || '';
const empty: PlayerSession = { authenticated: false, enabled: true, profile: 'showcase', user: null, operator: false, providers: [], capabilities: { providerSettings: false, discord: false, voice: false } };
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PlayerSession>(empty);
  const [status, setStatus] = useState<AuthStatus>('CHECKING');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const sequence = useRef(0);
  const identity = useRef<string | null>(null);
  function changed(next: PlayerSession) {
    const key = next.user ? `${next.user.id}:${next.operator}` : null;
    if (identity.current !== key) {
      identity.current = key;
      window.dispatchEvent(new CustomEvent('diplomacy-auth-changed', { detail: { signedOut: key === null } }));
    }
  }
  async function refresh(): Promise<void> {
    const request = ++sequence.current;
    try {
      const response = await fetch(`${apiBase}/api/auth/session`, { credentials: 'include' });
      if (!response.ok) throw new Error('Sign-in is temporarily unavailable. Please retry.');
      const next = await response.json() as PlayerSession;
      if (request !== sequence.current) return;
      setSession(next); setStatus(next.authenticated ? 'AUTHENTICATED' : 'LOGIN'); changed(next);
    } catch (error) {
      if (request !== sequence.current) return;
      setSession(empty); changed(empty); setStatus('ERROR');
      setMessage(error instanceof Error ? error.message : 'Sign-in is unavailable.');
    }
  }
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('auth')) {
      setMessage('Sign-in did not complete. Please try again.');
      url.searchParams.delete('auth'); window.history.replaceState(null, '', url);
    }
    void refresh();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const expired = () => { void refresh(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('diplomacy-session-expired', expired);
    return () => { sequence.current++; document.removeEventListener('visibilitychange', visible); window.removeEventListener('diplomacy-session-expired', expired); };
  }, []);
  async function logout(): Promise<void> {
    sequence.current++;
    setSubmitting(true); setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/auth/logout`, { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error('Sign-out could not be completed. Please retry.');
      const next = { ...session, authenticated: false, user: null, operator: false, capabilities: empty.capabilities };
      setSession(next); changed(next); setStatus('LOGIN');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Sign-out failed.'); }
    finally { setSubmitting(false); }
  }
  return <AuthContext.Provider value={{ ...session, status, message, submitting, refresh, logout,
    loginUrl: provider => `${apiBase}/api/auth/${provider}`,
  }}>{children}</AuthContext.Provider>;
}
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
