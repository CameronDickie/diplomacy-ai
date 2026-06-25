import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth.js';

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await auth.login(username, password);
  }

  return (
    <>
      {children}
      {!auth.authenticated && auth.enabled && (
        <section className="auth-popover">
          <h2>AI Sign In</h2>
          {auth.status === 'CHECKING' ? (
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
              {auth.message && <p className="auth-error">{auth.message}</p>}
              <button type="submit" className="primary" disabled={auth.submitting}>
                {auth.submitting ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
