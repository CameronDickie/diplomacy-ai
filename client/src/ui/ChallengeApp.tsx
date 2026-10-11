import { useEffect, useMemo, useRef, useState } from 'react';
import { TERRITORIES, type PublicPhaseReport } from '@diplomacy/shared';
import { useChallenge } from '../hooks/useChallenge.js';
import { DevLogView } from '../challenge/DevLog.js';
import { HistoryView } from '../challenge/History.js';
import { MessagesView } from '../challenge/Messages.js';
import { PlayView } from '../challenge/Play.js';
import { SetupView } from '../challenge/Setup.js';
import { Shell, type NavItem } from '../challenge/Shell.js';
import { title } from '../challenge/text.js';
import { useOrderEntry } from '../challenge/useOrderEntry.js';
import { MapGraph } from './MapGraph.js';
import { OperatorPanel } from './OperatorPanel.js';

type View = 'setup' | 'play' | 'messages' | 'history' | 'log' | 'operator';
type Replay = { reports: PublicPhaseReport[]; index: number; after: boolean; kind: 'REFERENCE' | 'EXHIBITION' | 'OWN'; name?: string };
const VIEWS: readonly View[] = ['setup', 'play', 'messages', 'history', 'log', 'operator'];
const fromHash = (): View | null => { const v = window.location.hash.replace(/^#\/?/, ''); return (VIEWS as readonly string[]).includes(v) ? v as View : null; };

/**
 * The challenge experience. Each kind of information has one place: Setup (the challenge and the ways
 * to play), Play (the map with this turn's orders), Messages, History (the orders log) and, in
 * development, the Playtest log. The address bar's hash names the place, so Back works.
 */
export function ChallengeApp() {
  const game = useChallenge(), a = game.attempt, card = a?.challenge ?? game.selected;
  const entry = useOrderEntry(a, card, game.legal, game.busy, game.auth.user?.id);
  const [view, setView] = useState<View | null>(fromHash);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { const onHash = () => { setView(fromHash()); setReplay(null); }; window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  const go = (next: View) => { setReplay(null); if (fromHash() === next) setView(next); else window.location.hash = `/${next}`; };
  // Starting or opening a game takes you to it; losing the game (sign-out, deletion) takes you back to setup.
  const lastAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (!game.loaded) return;
    const id = a?.id ?? null;
    if (id !== lastAttempt.current) { const first = lastAttempt.current === null && view !== null; lastAttempt.current = id; if (id && !first) go('play'); else if (!id) setReplay(null); }
  }, [a?.id, game.loaded]);
  useEffect(() => setReplay(null), [a?.id, a?.phaseId, game.auth.user?.id]);

  const sponsored = a?.mode === 'SPONSORED';
  const nav: NavItem[] = [{ id: 'setup', label: a ? 'Setup' : 'Challenge' },
    ...(a ? [{ id: 'play', label: 'Play' }] : []),
    ...(a && sponsored && game.chat ? [{ id: 'messages', label: 'Messages', count: game.chat.messages.length }] : []),
    ...(a ? [{ id: 'history', label: 'History', count: game.reports.length }] : []),
    ...(a && sponsored && game.playtest ? [{ id: 'log', label: 'Playtest log' }] : []),
    ...(game.auth.operator ? [{ id: 'operator', label: 'Operator' }] : [])];
  // A view that needs something you do not have falls back to the nearest one that makes sense.
  const wanted = view ?? (a?.lifecycle === 'ACTIVE' ? 'play' : 'setup');
  const current: View = nav.some(item => item.id === wanted) ? wanted : a && wanted !== 'operator' ? 'play' : 'setup';

  const report = replay?.reports[replay.index];
  const shown = report ? (replay!.after ? report.after : report.before) : current === 'setup' ? (game.selected?.board ?? a?.board) : entry.board;
  const mapState = useMemo(() => shown ? { units: shown.units, territories: Object.fromEntries(TERRITORIES.map(t => [t.id, { id: t.id, isSupplyCenter: t.isSupplyCenter, owner: shown.territoryOwners[t.id] }])) } : null, [shown]);
  const playing = current === 'play' && !replay;
  const map = <MapGraph gameState={mapState} selectedTerritory={playing ? entry.selected : null} selectedUnit={playing ? entry.selectedUnit : null}
    validTargets={playing && entry.selectedUnit ? entry.options.filter(o => o.unitTerritory === entry.selectedUnit!.territory && o.order.type === 'MOVE').map(o => o.order.targetTerritory!) : []}
    pendingOrders={report?.phase === 'ORDERS' ? report.resolvedOrders : playing ? entry.chosenOrders : []}
    onSelectTerritory={territory => { if (playing && entry.own.some(u => u.territory === territory)) { entry.setSelected(now => now === territory ? null : territory); void game.activity(); } }}
    onClearSelection={() => entry.setSelected(null)} />;

  return <Shell nav={nav} current={current} onNavigate={id => go(id as View)}>
    {game.error && <div className="dip-notice is-error" role="alert" style={{ marginTop: 16 }}>{game.error} <button onClick={game.clearError}>Dismiss</button>{!game.loaded && <button onClick={() => window.location.reload()}>Retry</button>}</div>}
    {!game.loaded && !game.error && <p style={{ padding: '40px 0' }} role="status">Loading the challenge…</p>}
    {replay && report ? <main id="dip-content">
      <div className="dip-replay" aria-label="Replay controls">
        <strong>{replay.kind === 'EXHIBITION' ? `Exhibition · ${replay.name}` : replay.kind === 'REFERENCE' ? 'Reference replay' : 'Your game'} · {title(report.season)} {report.year} {report.phase.toLowerCase()} · {replay.after ? 'Result' : 'Before'}</strong>
        <button disabled={replay.index === 0 && !replay.after} onClick={() => setReplay(r => r && ({ ...r, ...(r.after ? { after: false } : { index: r.index - 1, after: true }) }))}>Previous</button>
        <button disabled={replay.index === replay.reports.length - 1 && replay.after} onClick={() => setReplay(r => r && ({ ...r, ...(!r.after ? { after: true } : { index: r.index + 1, after: false }) }))}>Next</button>
        <button className="dip-solid" onClick={() => setReplay(null)}>{replay.kind === 'OWN' ? 'Return to the orders log' : a?.lifecycle === 'ACTIVE' ? 'Return to your game' : 'Return to setup'}</button>
      </div>
      <p className="dip-muted dip-small">{replay.kind === 'EXHIBITION' ? 'A game played entirely by the free practice bot, one bot for each of the seven powers. Nobody is playing it and it uses no AI model.'
        : replay.kind === 'REFERENCE' ? 'A recorded example run of this scenario, the same for every visitor. It is not your game and uses no AI model.' : 'A saved turn from your own game. Only you can see it.'}
        {a?.lifecycle === 'ACTIVE' && replay.kind !== 'OWN' ? ' Your game is untouched while you watch: its board and any orders you have chosen are waiting where you left them.' : ''}</p>
      <section className="dip-map" aria-label="Replay board">{map}<a className="dip-map-credit" href="/legal.html">Map: Godip contributors · GPL-3.0</a></section>
    </main>
      : !game.loaded ? null
      : current === 'operator' ? <main id="dip-content" style={{ paddingTop: 24 }}><OperatorPanel /></main>
      : current === 'play' && a && card ? <PlayView game={game} attempt={a} card={card} entry={entry} clock={clock} map={map} onHistory={() => go('history')} onSetup={() => go('setup')} />
      : current === 'messages' && a && card && game.chat ? <MessagesView chat={game.chat} human={card.humanPower} busy={game.busy} onSend={game.sendChat} />
      : current === 'history' && a && card ? <HistoryView reports={game.reports} human={card.humanPower} onShow={index => setReplay({ reports: game.reports, index, after: true, kind: 'OWN' })} />
      : current === 'log' && game.playtest ? <DevLogView log={game.playtest} onExport={game.exportRecord} />
      : <SetupView game={game} clock={clock} map={map} onContinue={() => go('play')}
          onWatchReference={() => game.demo && setReplay({ reports: game.demo.reports, index: 0, after: false, kind: 'REFERENCE' })}
          onWatchExhibition={(id, name) => void game.loadExhibition(id).then(r => { if (r.reports.length) setReplay({ reports: r.reports, index: 0, after: false, kind: 'EXHIBITION', name }); }).catch(() => {})} />}
  </Shell>;
}
