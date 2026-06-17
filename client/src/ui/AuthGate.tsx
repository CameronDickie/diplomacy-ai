import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

type AuthStatus = 'CHECKING' | 'AUTHENTICATED' | 'LOGIN' | 'ERROR';

interface SessionResponse {
  authenticated?: boolean;
  enabled?: boolean;
  message?: string;
}

const apiBase = import.meta.env.VITE_SERVER_URL || '';

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

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('CHECKING');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    requestSession()
      .then(session => {
        if (cancelled) return;
        setStatus(session.authenticated ? 'AUTHENTICATED' : 'LOGIN');
        setMessage(session.authenticated ? null : session.message ?? null);
      })
      .catch(error => {
        if (cancelled) return;
        setStatus('ERROR');
        setMessage(error instanceof Error ? error.message : 'Authentication check failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      if (!response.ok || !payload.authenticated) {
        setMessage(payload.message ?? 'Invalid login credentials');
        setStatus('LOGIN');
        return;
      }
      setStatus('AUTHENTICATED');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Login failed');
      setStatus('ERROR');
    } finally {
      setSubmitting(false);
    }
  }

  if (status === 'AUTHENTICATED') return <>{children}</>;

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1>Diplomacy</h1>
        <p>Enter the shared game credentials to continue.</p>
        {status === 'CHECKING' ? (
          <p className="auth-muted">Checking session...</p>
        ) : (
          <form onSubmit={submitLogin} className="auth-form">
            <label>
              Username
              <input
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {message && <p className="auth-error">{message}</p>}
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
