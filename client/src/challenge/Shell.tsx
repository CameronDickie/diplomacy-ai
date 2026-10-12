import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import './theme.css';

type ThemePreference = 'system' | 'light' | 'dark';
const storageKey = 'cam-theme';
function readPreference(): ThemePreference {
  try { const saved = localStorage.getItem(storageKey); if (saved === 'light' || saved === 'dark') return saved; } catch { /* The system theme still works without storage. */ }
  return 'system';
}
const ICONS: Record<ThemePreference, string> = {
  light: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  system: 'M4 5h16v11H4zM9 20h6M12 16v4',
  dark: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
};
/** Light, system or dark, as on camerondickie.ca: resolved before paint by index.html, kept in local storage. */
function ThemePicker() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.folioTheme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference; };
    apply();
    media.addEventListener('change', apply);
    try { localStorage.setItem(storageKey, preference); } catch { /* Optional persistence. */ }
    return () => media.removeEventListener('change', apply);
  }, [preference]);
  return <div className="dip-theme" role="group" aria-label="Color theme">
    {([['light', 'Light theme'], ['system', 'Use system theme'], ['dark', 'Dark theme']] as const).map(([value, label]) =>
      <button key={value} type="button" aria-label={label} title={label} aria-pressed={preference === value} onClick={() => setPreference(value)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[value]} /></svg>
      </button>)}
  </div>;
}

const arrowPath = 'M0 5.625H7.625L4.125 9.125 5 10 10 5 5 0 4.125.875 7.625 4.375H0Z';
/** The site's arrow-fill action. Adapted from ObsidianUI's Arrow Fill Button (MIT); see THIRD_PARTY_NOTICES.md. */
export function ArrowFillButton({ children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return <button type="button" className={`dip-fill ${className}`.trim()} {...props}>
    <span className="dip-fill__label">{children}</span>
    <span className="dip-fill__fill" aria-hidden="true"><span>{children}</span>
      <svg className="dip-fill__arrow" viewBox="0 0 10 10" focusable="false"><path d={arrowPath} /><path d={arrowPath} /></svg></span>
  </button>;
}

export interface NavItem { id: string; label: string; count?: number }
/**
 * The shared frame of both ways to play: the site monogram home link, the switch between the daily
 * challenge and hosted games, the views of the current game, the account and the theme.
 * Hosted games do not exist in the showcase profile, so the switch is only shown where both do.
 */
export function Shell({ nav, current, onNavigate, section, children }: { nav: NavItem[]; current: string; onNavigate: (id: string) => void; section: 'challenge' | 'games'; children: ReactNode }) {
  const auth = useAuth();
  const both = auth.status !== 'CHECKING' && auth.status !== 'ERROR' && auth.profile !== 'showcase';
  return <div className="dip">
    <div className="dip-wrap">
      <header className="dip-header">
        <span className="dip-brand">
          <a className="dip-monogram" href="https://camerondickie.ca" aria-label="Cameron Dickie, home">cd
            <svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><path className="dip-mark-start" d="M44 12H12V44" stroke="currentColor" strokeWidth="12" /><path className="dip-mark-end" d="M56 88H88V56" stroke="currentColor" strokeWidth="12" /></svg></a>
          <span className="dip-wordmark">Diplomacy</span>
        </span>
        {both && <nav className="dip-switch" aria-label="Ways to play">
          <a href="/challenge" aria-current={section === 'challenge' ? 'page' : undefined}>Daily challenge</a>
          <a href="/" aria-current={section === 'games' ? 'page' : undefined}>Hosted games</a>
        </nav>}
        <nav className="dip-nav" aria-label="Game sections">
          {nav.map(item => <button key={item.id} type="button" aria-current={current === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
            {item.label}{item.count ? <span className="dip-nav-count">{item.count}</span> : null}</button>)}
        </nav>
        <div className="dip-account" aria-label="Player account">
          {auth.status === 'CHECKING' ? <span className="dip-muted">Checking session…</span> : auth.authenticated ? <>
            <span>{auth.user?.displayName}{auth.operator ? ' · Operator' : ''}</span>
            <button type="button" className="dip-link" onClick={() => void auth.logout()} disabled={auth.submitting}>{auth.submitting ? 'Signing out…' : 'Sign out'}</button>
          </> : <>
            {auth.providers.map(provider => <a key={provider} href={auth.loginUrl(provider)}>Sign in with {provider === 'github' ? 'GitHub' : 'Google'}</a>)}
            {auth.devSignIn === true && <button type="button" className="dip-link" onClick={() => void auth.devLogin()} disabled={auth.submitting}>Continue as local developer (development only)</button>}
            {auth.providers.length === 0 && !auth.devSignIn && auth.status !== 'ERROR' && <span className="dip-muted">Sign-in is not configured on this server.</span>}
            {auth.status === 'ERROR' && <button type="button" className="dip-link" onClick={() => void auth.refresh()}>Retry sign-in check</button>}
          </>}
          <ThemePicker />
        </div>
      </header>
      {auth.message && <p role="alert" className="dip-notice is-error" style={{ marginTop: 16 }}>{auth.message}</p>}
      {children}
      <footer className="dip-footer">
        <span><a href="https://camerondickie.ca">Cameron Dickie</a> · <a href="/legal.html">Credits &amp; licenses</a> · <a href="https://github.com/CameronDickie/diplomacy-ai" target="_blank" rel="noreferrer">Source code</a></span>
        <span>Map: Godip contributors · GPL-3.0</span>
      </footer>
    </div>
  </div>;
}
