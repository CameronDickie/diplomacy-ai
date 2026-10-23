import { useState } from 'react';
import { ALL_POWERS, type AutoplayGameFile, type ChallengeLegalCatalog, type Power, type Unit } from '@diplomacy/shared';
import { challengeRequest } from '../hooks/useChallenge.js';
import { ArrowFillButton } from '../challenge/Shell.js';
import { title } from '../challenge/text.js';
import { MODEL_NAMES, modelKey } from './record.js';

/** What the development server's full-games service reports (see server/src/autoplay/FullGameService.ts). */
type Provider = 'OPENAI' | 'ANTHROPIC';
export interface FullGamesList {
  /** `standIn`: a free game with simulated models, kept in a separate database from the real ledger. */
  games: Array<{ runId: string; standIn: boolean; seat: Power | null; lifecycle: string; year: number; season: string; phase: string; centers: Record<Power, number>; running: boolean; waiting: boolean; createdAt: number; updatedAt: number }>;
  funding: { availableNanousd: number; attemptCapNanousd: number; providers: Record<Provider, { availableNanousd: number } | null> };
  paidStopped: boolean; running: string | null; keys: Record<Provider, boolean>;
  models: Record<string, { model: string; provider: Provider }>; defaultAssignment: Record<Power, string>;
}
export interface GameSettings { assignment: Record<Power, string>; lastYear: number; effort: 'low' | 'medium' | 'high'; transport: 'mock' | 'live'; talkRecipients: number; seat: Power | null }
export type LiveGame = AutoplayGameFile & { settings: GameSettings; standIn: boolean; current: BoardSnapshot;
  live: { running: boolean; log: string[]; startedAt: number | null; error: string | null; status: string; waitingOn: string | null; waitingFor: { kind: 'TALK' | 'ACT'; phaseId: string } | null } };
/** The board as it stands now (the phase being played), as the server stores it. */
export interface BoardSnapshot { year: number; season: 'SPRING' | 'FALL' | 'WINTER'; phase: 'ORDERS' | 'RETREATS' | 'BUILDS'; units: Unit[]; territoryOwners: Record<string, Power | null> }
export interface StartRequest {
  runId: string; assignment: Record<Power, string>; until: number | 'win'; effort: 'low' | 'medium' | 'high'; messages: number;
  live: boolean; authorizationRef?: string; attemptCapUsd?: number; resumePaid?: boolean;
  /** You play this power; the game waits for you each phase. */
  seat?: Power;
}

export const fullGamesApi = {
  list: () => challengeRequest<FullGamesList>('/full-games'),
  game: (runId: string) => challengeRequest<LiveGame>(`/full-games/${encodeURIComponent(runId)}`),
  start: (request: StartRequest) => challengeRequest<{ runId: string }>('/full-games', request),
  stop: (runId: string) => challengeRequest<{ stopping: boolean }>(`/full-games/${encodeURIComponent(runId)}/stop`, {}),
  legal: (runId: string) => challengeRequest<ChallengeLegalCatalog>(`/full-games/${encodeURIComponent(runId)}/legal`),
  talk: (runId: string, messages: Array<{ to: Power; body: string }>, phaseId: string) => challengeRequest<{ sent: boolean }>(`/full-games/${encodeURIComponent(runId)}/talk`, { messages, phaseId }),
  act: (runId: string, action: unknown, phaseId: string) => challengeRequest<{ accepted: boolean }>(`/full-games/${encodeURIComponent(runId)}/act`, { action, phaseId }),
};
const usd = (nanousd: number) => `USD ${(nanousd / 1e9).toFixed(2)}`;
// The last grant reference used is remembered in this browser only, as a convenience.
const REF_KEY = 'viewer-authorization-ref';
const rememberedRef = () => { try { return localStorage.getItem(REF_KEY) ?? ''; } catch { return ''; } };
const rememberRef = (ref: string) => { try { localStorage.setItem(REF_KEY, ref); } catch { /* optional */ } };

/** Funding as the games will meet it: each provider's own budget where it has one. */
export function Budgets({ list, inline = false }: { list: FullGamesList; inline?: boolean }) {
  const budgets = (['OPENAI', 'ANTHROPIC'] as const).filter(p => list.funding.providers[p]);
  const Tag = inline ? 'span' : 'p';
  return <Tag className={inline ? undefined : 'dip-muted dip-small'}>
    {budgets.length ? budgets.map(p => `${p === 'OPENAI' ? 'OpenAI' : 'Anthropic'} ${usd(list.funding.providers[p]!.availableNanousd)} left`).join(' · ') : `${usd(list.funding.availableNanousd)} available`}
    {' '}· per-game cap {usd(list.funding.attemptCapNanousd)}{list.paidStopped ? ' · paid play is paused (a budget ran out); continuing a game can lift the pause' : ''}
  </Tag>;
}

/** Paid settings shared by starting and continuing: which grant authorizes it, the cap, lifting a pause. */
function PaidFields({ list, providers, state, onChange }: { list: FullGamesList; providers: Provider[]; state: { ref: string; cap: string; resume: boolean }; onChange: (s: { ref: string; cap: string; resume: boolean }) => void }) {
  const missing = providers.filter(p => !list.keys[p]);
  return <>
    <label>Funding grant that authorizes it<input value={state.ref} onChange={e => onChange({ ...state, ref: e.target.value })} placeholder="autoplay-openai-0001" /></label>
    <label>Per-game cap (USD, at most 15)<input type="number" min={1} max={15} step={0.5} value={state.cap} onChange={e => onChange({ ...state, cap: e.target.value })} /></label>
    {list.paidStopped && <label className="dip-check"><input type="checkbox" checked={state.resume} onChange={e => onChange({ ...state, resume: e.target.checked })} /> Lift the pause on paid play</label>}
    {missing.length > 0 && <p className="dip-notice is-error">This server has no {missing.map(p => p === 'OPENAI' ? 'OpenAI' : 'Anthropic').join(' or ')} key in its environment. Start it with scripts/dev-games.sh.</p>}
  </>;
}

/**
 * Starting a game against the AI: your power and who plays the others come first, then how long it lasts.
 * The autoplay command's other choices (name, reasoning effort, messages per turn) are under More settings.
 * Choosing no power starts a game the models play alone.
 */
export function NewGameForm({ list, onStarted }: { list: FullGamesList; onStarted: (runId: string) => void }) {
  const keys = Object.keys(list.models);
  const [runId, setRunId] = useState(() => `game-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`);
  const [assignment, setAssignment] = useState<Record<Power, string>>(list.defaultAssignment);
  const [perPower, setPerPower] = useState(false);
  const [until, setUntil] = useState('win');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('low');
  const [messages, setMessages] = useState(3);
  const [live, setLive] = useState(false);
  const [seat, setSeat] = useState<Power | ''>(() => ALL_POWERS[Math.floor(Math.random() * ALL_POWERS.length)]);
  const [paid, setPaid] = useState({ ref: rememberedRef(), cap: '5', resume: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opponents = ALL_POWERS.filter(p => p !== seat);
  const providers = [...new Set(opponents.map(p => list.models[assignment[p]]?.provider))].filter(Boolean) as Provider[];
  // One model for every opponent, unless they have been chosen power by power.
  const shared = new Set(opponents.map(p => assignment[p])).size === 1 ? assignment[opponents[0]] : 'mixed';
  const name = (key: string) => MODEL_NAMES[modelKey(list.models[key].model)];
  async function submit() {
    setBusy(true); setError(null);
    try {
      if (live) rememberRef(paid.ref);
      const started = await fullGamesApi.start({ runId, assignment, until: until === 'win' ? 'win' : Number(until), effort, messages, live, ...(seat ? { seat } : {}),
        ...(live ? { authorizationRef: paid.ref, attemptCapUsd: Number(paid.cap), resumePaid: paid.resume } : {}) });
      onStarted(started.runId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main id="dip-content">
    <div className="dip-heading"><p className="dip-meta">Games</p><h1>Play against <span>the AI</span></h1>
      <p>You take one power and AI models play the other six. Every orders turn they write first, you answer anyone you like, they reply, and everyone gives orders. The game waits for you as long as you need.</p></div>
    {list.running && <p className="dip-notice" role="status">Game {list.running} is being played on this server. Stop it before starting another.</p>}
    <form className="dip-form new-game" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="dip-form-grid">
        <label>Your power<select value={seat} onChange={e => setSeat(e.target.value as Power | '')}>
          {ALL_POWERS.map(p => <option key={p} value={p}>{title(p)}</option>)}<option value="">Nobody: watch the AI play itself</option></select></label>
        <label>Opponents<select value={shared} disabled={perPower} onChange={e => { const key = e.target.value; setAssignment(a => ({ ...a, ...Object.fromEntries(opponents.map(p => [p, key])) })); }}>
          {shared === 'mixed' && <option value="mixed">A mix of models</option>}
          {keys.map(k => <option key={k} value={k}>{name(k)} on every power</option>)}</select></label>
        <label>Game length<select value={until} onChange={e => setUntil(e.target.value)}>
          <option value="win">Until a power wins (or ten years without a change)</option>{[1910, 1920, 1930, 1950, 1975].map(y => <option key={y} value={y}>Until Fall {y}</option>)}</select></label>
        <label>AI models<select value={live ? 'live' : 'mock'} onChange={e => setLive(e.target.value === 'live')}>
          <option value="mock">Stand-in models (free, random legal moves)</option><option value="live">Live models (paid)</option></select></label>
      </div>
      <label className="dip-check"><input type="checkbox" checked={perPower} onChange={e => setPerPower(e.target.checked)} /> Choose a model for each power</label>
      {perPower && <div className="dip-form-grid">{ALL_POWERS.map(p => <label key={p}>{title(p)}
        {p === seat ? <select disabled value="you"><option value="you">You</option></select>
          : <select value={assignment[p]} onChange={e => setAssignment({ ...assignment, [p]: e.target.value })}>
          {keys.map(k => <option key={k} value={k}>{name(k)}</option>)}</select>}</label>)}</div>}
      <details className="new-game-more"><summary>More settings</summary>
        <div className="dip-form-grid">
          <label>Game name<input value={runId} onChange={e => setRunId(e.target.value.toLowerCase())} pattern="[a-z0-9-]{3,40}" title="3–40 lowercase letters, digits or dashes" required /></label>
          <label>Reasoning effort<select value={effort} onChange={e => setEffort(e.target.value as typeof effort)}>
            <option value="low">Low (as the challenge)</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <label>Powers each AI may write to per turn<select value={messages} onChange={e => setMessages(Number(e.target.value))}>
            {[0, 1, 2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n === 0 ? 'None' : `Up to ${n}`}</option>)}</select></label>
        </div>
      </details>
      {live && <><Budgets list={list} /><PaidFields list={list} providers={providers} state={paid} onChange={setPaid} /></>}
      {error && <p className="dip-notice is-error" role="alert">{error}</p>}
      <div><ArrowFillButton type="submit" disabled={busy || Boolean(list.running)}>{busy ? 'Starting…' : live ? 'Start the paid game' : 'Start the game'}</ArrowFillButton></div>
    </form>
  </main>;
}

/** The running game's status, Stop and Continue, and its log. */
export function LiveControls({ game, list, onChanged }: { game: LiveGame; list: FullGamesList | null; onChanged: () => void }) {
  const [paid, setPaid] = useState({ ref: rememberedRef(), cap: String(list ? list.funding.attemptCapNanousd / 1e9 : 5), resume: false });
  // A game continues with the kind of models it was started with.
  const live = !game.standIn;
  // While a person plays a seat, the log leaves out the models' failed answers, which quote their intended orders.
  const log = game.settings.seat && game.status !== 'FINISHED' ? game.live.log.filter(line => !line.trimStart().startsWith('!')) : game.live.log;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = game.live.status, finished = game.status === 'FINISHED' && !game.live.running;
  const providers = [...new Set(ALL_POWERS.filter(p => p !== game.settings.seat).map(p => list?.models[game.settings.assignment[p]]?.provider))].filter(Boolean) as Provider[];
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const resume = () => act(() => { if (live) rememberRef(paid.ref); return fullGamesApi.start({ runId: game.run.runId, assignment: game.settings.assignment,
    until: game.settings.lastYear >= 1999 ? 'win' : game.settings.lastYear, effort: game.settings.effort, messages: game.settings.talkRecipients, live, ...(game.settings.seat ? { seat: game.settings.seat } : {}),
    ...(live ? { authorizationRef: paid.ref, attemptCapUsd: Number(paid.cap), resumePaid: paid.resume } : {}) }); });
  return <section className="viewer-live" aria-label="This game">
    <p><strong className={game.live.running ? 'is-running' : ''}>{game.live.running ? 'Being played' : finished ? 'Finished' : status === 'WAITING' ? 'Waiting' : 'Paused'}</strong>
      {' '}<span className="dip-muted">· {game.standIn ? 'stand-in models (free)' : 'live models'} · {game.settings.effort} effort · {game.settings.lastYear >= 1999 ? 'until a win' : `to Fall ${game.settings.lastYear}`}</span></p>
    {game.live.waitingOn && !game.live.running && <p className="dip-small">{game.live.waitingOn}</p>}
    {game.live.error && <p className="dip-notice is-error">{game.live.error}</p>}
    {error && <p className="dip-notice is-error" role="alert">{error}</p>}
    <div className="viewer-live-actions">
      {game.live.running && <button type="button" disabled={busy} onClick={() => void act(() => fullGamesApi.stop(game.run.runId))}>{game.settings.seat ? 'Pause the game' : 'Stop after this phase'}</button>}
      {!game.live.running && !finished && list && <>
        <button type="button" className="dip-solid" disabled={busy || Boolean(list.running)} onClick={() => void resume()}>{busy ? 'Starting…' : live ? 'Continue (paid)' : 'Continue (free)'}</button>
      </>}
    </div>
    {!game.live.running && !finished && list && live && <div className="dip-form"><PaidFields list={list} providers={providers} state={paid} onChange={setPaid} /></div>}
    {log.length > 0 && <details open={game.live.running && !game.settings.seat}><summary>Log ({log.length} lines)</summary>
      <pre className="viewer-log">{log.slice(-40).join('\n')}</pre></details>}
  </section>;
}
