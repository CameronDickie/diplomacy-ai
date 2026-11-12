import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
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

/**
 * Brings a message into view and moves focus to it when it appears or changes, so a result shown far
 * from the button that caused it (an error at the top of a long page, say) is not missed. The element
 * needs tabIndex={-1}.
 */
export function useReveal<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!key || !element) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
    element.focus({ preventScroll: true });
  }, [key]);
  return ref;
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
 * challenge and Games (full games against the AI, with friends, or watched; the game viewer is part of
 * Games), the views of the current game, the account and the theme. Games exist in the showcase profile
 * only once the owner turns them on, so the switch is only shown where both do.
 */
/** A disclosure that closes on a click outside it or Escape, as a menu would. */
function SignInMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const menu = ref.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menu.contains(event.target as Node)) {
        menu.open = false;
        if (event instanceof KeyboardEvent) menu.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, []);
  return <details ref={ref} className="dip-signin"><summary>Sign in</summary>{children}</details>;
}

/** The way between the daily challenge and Games, where the server offers both. */
function PlaySwitch({ section }: { section: 'challenge' | 'games' | 'viewer' }) {
  const auth = useAuth();
  if (auth.status === 'CHECKING' || auth.status === 'ERROR' || !auth.capabilities.games) return null;
  return <nav className="dip-switch" aria-label="Ways to play">
    <a href="/challenge" aria-current={section === 'challenge' ? 'page' : undefined}>Daily challenge</a>
    <a href="/" aria-current={section === 'games' || section === 'viewer' ? 'page' : undefined}>Games</a>
  </nav>;
}

function Account() {
  const auth = useAuth();
  return auth.status === 'CHECKING' ? <span className="dip-muted">Checking session…</span> : auth.authenticated ? <>
    <span className="dip-account-name">{auth.user?.displayName}</span>
    {/* The Operator view lives in the challenge frame; from Games it is otherwise out of reach. */}
    {auth.operator && <a className="dip-link" href="/challenge#/operator">Operator</a>}
    <button type="button" className="dip-link" onClick={() => void auth.logout()} disabled={auth.submitting}>{auth.submitting ? 'Signing out…' : 'Sign out'}</button>
  </> : <>
    {(auth.providers.length > 0 || auth.devSignIn === true) && <SignInMenu>
      <div className="dip-signin-menu">
        {auth.providers.map(provider => <a key={provider} href={auth.loginUrl(provider)}>Sign in with {provider === 'github' ? 'GitHub' : 'Google'}</a>)}
        {auth.devSignIn === true && <button type="button" className="dip-link" onClick={() => void auth.devLogin()} disabled={auth.submitting}>Continue as local developer (development only)</button>}
      </div>
    </SignInMenu>}
    {auth.providers.length === 0 && !auth.devSignIn && auth.status !== 'ERROR' && <span className="dip-muted">Sign-in is not configured on this server.</span>}
    {auth.status === 'ERROR' && <button type="button" className="dip-link" onClick={() => void auth.refresh()}>Retry sign-in check</button>}
  </>;
}

function AuthMessage() {
  const auth = useAuth();
  const ref = useReveal<HTMLParagraphElement>(auth.message);
  return auth.message ? <p role="alert" ref={ref} tabIndex={-1} className="dip-notice is-error" style={{ marginTop: 16 }}>{auth.message}</p> : null;
}

/**
 * `server={false}`: the static copy of the game viewer, with no game server behind it, so no sign-in and
 * no way to the daily challenge. It links only to what it contains (the source repository is private).
 */
export function Shell({ nav, current, onNavigate, section, server = true, children }: { nav: NavItem[]; current: string; onNavigate: (id: string) => void; section: 'challenge' | 'games' | 'viewer'; server?: boolean; children: ReactNode }) {
  return <div className="dip">
    <div className="dip-wrap">
      <header className="dip-header">
        <span className="dip-brand">
          <a className="dip-monogram" href="https://camerondickie.ca" aria-label="Cameron Dickie, home">cd
            <svg viewBox="0 0 100 100" fill="none" aria-hidden="true"><path className="dip-mark-start" d="M44 12H12V44" stroke="currentColor" strokeWidth="12" /><path className="dip-mark-end" d="M56 88H88V56" stroke="currentColor" strokeWidth="12" /></svg></a>
          <span className="dip-wordmark">Diplomacy</span>
        </span>
        {server && <PlaySwitch section={section} />}
        <nav className="dip-nav" aria-label="Game sections">
          {nav.map(item => <button key={item.id} type="button" aria-current={current === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
            {item.label}{item.count ? <span className="dip-nav-count">{item.count}</span> : null}</button>)}
        </nav>
        <div className="dip-account" aria-label={server ? 'Player account' : 'Display'}>
          {server && <Account />}
          <ThemePicker />
        </div>
      </header>
      {server && <AuthMessage />}
      {children}
      <footer className="dip-footer">
        <span><a href="https://camerondickie.ca">Cameron Dickie</a> · <a href={`${import.meta.env.BASE_URL}legal.html`}>Credits &amp; licenses</a>
          {server && <> · <a href="https://github.com/CameronDickie/diplomacy-ai" target="_blank" rel="noreferrer">Source code</a></>}</span>
        <span>Map: Godip contributors · GPL-3.0</span>
      </footer>
    </div>
  </div>;
}
