import type { ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth.js';

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const challenge = auth.profile === 'showcase' || window.location.pathname === '/challenge';
  // The challenge has its own shell, with sign-in in its header.
  if (challenge) return <>{children}</>;
  return <div>
    {children}
    {(auth.enabled || auth.status === 'ERROR') && <section className="auth-popover" aria-label="Player account">
      <h2>{auth.authenticated ? 'Player account' : 'Sign in to play'}</h2>
      {auth.status === 'CHECKING' ? <p className="auth-muted">Checking session…</p> : auth.authenticated ? <>
        <p>{auth.user?.displayName} · {auth.devSignIn && auth.user?.displayName === 'Local developer' ? 'development sign-in' : auth.user?.provider === 'github' ? 'GitHub' : 'Google'}{auth.operator ? ' · Operator' : ''}</p>
        <button onClick={() => void auth.logout()} disabled={auth.submitting}>{auth.submitting ? 'Signing out…' : 'Sign out'}</button>
      </> : <>
        <p className="auth-muted">Browsing is public. Sign in to save your challenge progress.</p>
        <div className="auth-form">
          {auth.providers.map(provider => <a className="auth-provider-link" key={provider} href={auth.loginUrl(provider)}>
            Continue with {provider === 'github' ? 'GitHub' : 'Google'}
          </a>)}
          {auth.devSignIn === true && <button className="auth-provider-link" onClick={() => void auth.devLogin()} disabled={auth.submitting}>
            Continue as local developer (development only)
          </button>}
        </div>
        {auth.providers.length === 0 && !auth.devSignIn && auth.status !== 'ERROR' && <p>Player sign-in is not configured on this server.</p>}
        {auth.status === 'ERROR' && <button onClick={() => void auth.refresh()}>Retry sign-in check</button>}
      </>}
      {auth.message && <p role="alert" className="auth-error">{auth.message}</p>}
    </section>}
  </div>;
}
