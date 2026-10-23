import { useEffect, useMemo, useRef, useState } from 'react';
import { gamePhaseId, type GameState, type PublicBoardSnapshot, type PublicPhaseReport } from '@diplomacy/shared';
import { HistoryView } from '../challenge/History.js';
import { Shell, useReveal, type NavItem } from '../challenge/Shell.js';
import { useAuth } from '../hooks/useAuth.js';
import { useGameSocket } from '../hooks/useGameSocket.js';
import { useOrderEntry } from '../challenge/useOrderEntry.js';
import { heldTerritories } from '../lib/game.js';
import { MapGraph } from '../ui/MapGraph.js';
import { GameView } from './Game.js';
import { GamesHome } from './GamesHome.js';
import { MessagesView } from './Messages.js';
import { PlayView } from './Play.js';
import { ReplayBar } from './ReplayBar.js';
import { exportPublicArchive } from './archive.js';
import './rooms.css';

type View = 'game' | 'play' | 'messages' | 'history' | 'log';
const VIEWS: readonly View[] = ['game', 'play', 'messages', 'history', 'log'];
const fromHash = (): View | null => { const v = window.location.hash.replace(/^#\/?/, ''); return (VIEWS as readonly string[]).includes(v) ? v as View : null; };
const ignoreMapSelection = () => undefined;
const NO_OPTIONS = { attemptId: '', phaseId: '', revision: 0, options: [] };

/**
 * Hosted games: a full seven-power game that people create, share by code and play to its end.
 * It uses the same frame, map and controls as the daily challenge, and gives each kind of
 * information one place: Game (seats and settings), Play (the map with this turn's orders),
 * Messages, History and, for the host, the Event log.
 */
export function RoomApp() {
  const auth = useAuth();
  const game = useGameSocket();
  const state = game.gameState;
  const [view, setView] = useState<View | null>(fromHash);
  const [seenMessages, setSeenMessages] = useState(0);
  const [replayReport, setReplayReport] = useState<PublicPhaseReport | null>(null);
  const [replayFrame, setReplayFrame] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replayRun, setReplayRun] = useState(0);
  const started = Boolean(state && state.status !== 'LOBBY');
  const isHost = Boolean(state && state.hostPlayerId === game.myPlayerId);
  // The newest notification is shown above the page; bring it into view wherever the action was.
  const latestError = useReveal<HTMLDivElement>(game.errors[game.errors.length - 1]?.id);

  const closeReplay = () => { setReplayReport(null); setReplayPlaying(false); };
  useEffect(() => { const onHash = () => { setView(fromHash()); closeReplay(); }; window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  const go = (next: View) => { closeReplay(); if (fromHash() === next) setView(next); else window.location.hash = `/${next}`; };
  // The moment a game starts, everyone is taken to the map.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = state?.status ?? null;
    if (lastStatus.current === 'LOBBY' && status === 'IN_PROGRESS') go('play');
    lastStatus.current = status;
  }, [state?.status]);

  useEffect(() => {
    if (!replayReport || !replayPlaying) return;
    if (replayFrame >= 2) { setReplayPlaying(false); return; }
    const timer = window.setTimeout(() => setReplayFrame(frame => Math.min(2, frame + 1)), 1400 / replaySpeed);
    return () => window.clearTimeout(timer);
  }, [replayFrame, replayPlaying, replayReport, replaySpeed]);

  // Outside a game the Games home stands alone; in one, its views.
  const nav: NavItem[] = !state ? [] : [{ id: 'game', label: 'Game' },
    ...(started ? [{ id: 'play', label: 'Play' }] : []),
    ...(state && game.myPower ? [{ id: 'messages', label: 'Messages', count: Math.max(0, game.diplomaticMessages.length - seenMessages) }] : []),
    ...(started ? [{ id: 'history', label: 'History', count: game.phaseHistory.length }] : []),
    ...(state && isHost ? [{ id: 'log', label: 'Event log' }] : [])];
  const wanted = view ?? (started ? 'play' : 'game');
  const current: View = nav.some(item => item.id === wanted) ? wanted : 'game';
  useEffect(() => { if (current === 'messages') setSeenMessages(game.diplomaticMessages.length); }, [current, game.diplomaticMessages.length]);

  const displayedState = useMemo(() => {
    if (!state || !replayReport) return state;
    return gameStateFromSnapshot(state, replayReport, replayFrame < 2 ? replayReport.before : replayReport.after);
  }, [state, replayFrame, replayReport]);
  const playing = current === 'play' && !replayReport;
  // Earlier turns of whatever is shown: the replayed turn's predecessors, or every resolved turn.
  const held = useMemo(() => { const at = replayReport ? game.phaseHistory.indexOf(replayReport) : -1;
    return heldTerritories(at >= 0 ? game.phaseHistory.slice(0, at) : game.phaseHistory, displayedState?.units); }, [game.phaseHistory, replayReport, displayedState]);

  // This turn's decisions use the same order entry as the daily challenge and the seat against the AI: the rules
  // engine's legal orders, one menu per unit in words, click-to-move on the map, retreats and builds.
  const myPower = game.myPower;
  const board = useMemo(() => state ? { year: state.year, season: state.season, phase: state.phase, units: state.units,
    territoryOwners: Object.fromEntries(Object.entries(state.territories).map(([id, t]) => [id, t.owner ?? null])) } : null, [state]);
  const phaseId = state ? gamePhaseId(state) : '';
  const submitted = Boolean(state && myPower && state.submittedPowers.includes(myPower)) || ['SUBMITTING', 'ACCEPTED'].includes(game.submission?.status ?? '');
  const canDecide = Boolean(state && myPower && state.status === 'IN_PROGRESS' && !submitted);
  const attemptLike = useMemo(() => board && { id: state!.gameId, phaseId, lifecycle: 'ACTIVE', execution: canDecide ? 'ACCEPTING' : 'DECIDING', board }, [board, phaseId, canDecide]);
  const catalog = !board ? null : board.phase === 'ORDERS' ? (game.legalOrders ? { attemptId: state!.gameId, phaseId, revision: 0, options: game.legalOrders.options } : null) : NO_OPTIONS;
  const entry = useOrderEntry(attemptLike as never, (myPower && board ? { humanPower: myPower, board } : undefined) as never, catalog, game.submission?.status === 'SUBMITTING', game.myPlayerId ?? undefined);
  function submitTurn() {
    const action = entry.submission();
    if (!action) return;
    // A legal option carries its whole order; the room checks it against the same rules engine.
    if (action.phase === 'ORDERS') game.submitOrders(action.orderIds.map(id => ({ ...catalog!.options.find(option => option.id === id)!.order, id: crypto.randomUUID() })));
    else if (action.phase === 'RETREATS') game.submitRetreats(action.retreats);
    else game.submitBuilds({ builds: action.builds, disbands: action.disbands });
  }
  const displayedOrders = replayReport ? (replayReport.phase === 'ORDERS' && replayFrame === 1 ? replayReport.resolvedOrders : []) : playing && board?.phase === 'ORDERS' ? entry.chosenOrders : [];
  function replay(report: PublicPhaseReport) { document.querySelector('.dip')?.scrollTo(0, 0); setReplayReport(report); setReplayFrame(0); setReplayPlaying(true); setReplayRun(run => run + 1); }

  const interactive = playing && Boolean(game.myPower);
  const map = <MapGraph
    gameState={displayedState}
    heldTerritories={held}
    selectedTerritory={interactive ? entry.selected as never : null}
    selectedUnit={interactive ? entry.selectedUnit : null}
    validTargets={interactive && canDecide ? entry.moveTargets as never[] : []}
    pendingOrders={displayedOrders}
    replayStandoffs={replayReport?.phase === 'ORDERS' && replayFrame === 2 ? replayReport.standoffTerritories : []}
    unitAnimationFrom={replayReport && replayFrame === 2 ? replayReport.before.units : undefined}
    unitAnimationKey={replayReport && replayFrame === 2 ? `${replayReport.id}-${replayRun}` : null}
    onSelectTerritory={interactive ? selectOnMap : ignoreMapSelection}
    onClearSelection={() => entry.setSelected(null)} />;
  // A unit of yours selects (or lets go); with one selected, a highlighted place orders the move and any
  // other place narrows its menu to the orders involving that place.
  function selectOnMap(territory: string) {
    if (canDecide) entry.place(territory);
    else if (entry.active.some(unit => unit.territory === territory)) entry.setSelected(now => now === territory ? null : territory);
  }
  const credit = <a className="dip-map-credit" href="/legal.html">Map: Godip contributors · GPL-3.0</a>;

  return <Shell section="games" nav={nav} current={current} onNavigate={id => go(id as View)}>
    <div aria-label="Game notifications">
      {game.errors.map((error, i) => <div className="dip-notice is-error" role="alert" key={error.id} ref={i === game.errors.length - 1 ? latestError : undefined} tabIndex={-1} style={{ marginTop: 16 }}>
        <span>{error.message}</span> <button type="button" aria-label="Dismiss notification" onClick={() => game.dismissError(error.id)}>Dismiss</button></div>)}
    </div>
    {auth.status === 'CHECKING' ? <p style={{ padding: '40px 0' }} role="status">Loading…</p>
      : replayReport ? <main id="dip-content">
        <ReplayBar report={replayReport} frame={replayFrame} playing={replayPlaying} speed={replaySpeed}
          onFrameChange={frame => { setReplayFrame(frame); setReplayPlaying(false); }}
          onPlayingChange={next => { if (next && replayFrame === 2) { setReplayFrame(0); setReplayRun(run => run + 1); } setReplayPlaying(next); }}
          onSpeedChange={setReplaySpeed} onClose={closeReplay} />
        <section className="dip-map" aria-label="Replay board">{map}{credit}</section>
      </main>
      : current === 'play' && state ? <PlayView game={game} state={state} map={<>{map}{credit}</>} entry={entry} legalReady={Boolean(catalog)}
          canDecide={canDecide} onSubmit={submitTurn} onGame={() => go('game')} onHistory={() => go('history')} />
      : current === 'messages' && state ? <MessagesView game={game} />
      : current === 'history' && state ? <HistoryView reports={game.phaseHistory} human={game.myPower} onShow={index => replay(game.phaseHistory[index])}
          intro="Every turn of this game so far: what each power ordered and whether it worked. Everyone in the game sees the same log."
          actions={<div><button type="button" disabled={game.phaseHistory.length === 0} onClick={() => exportPublicArchive(state, game.phaseHistory)}>Export the game as JSON</button></div>} />
      : current === 'log' && state ? <main id="dip-content">
          <div className="dip-heading"><p className="dip-meta">Host only</p><h1>Event <span>log</span></h1>
            <p>What this browser has sent to and received from the game server, newest first. Useful when something looks stuck.</p></div>
          {game.logs.length === 0 ? <p className="dip-muted">Nothing yet.</p> : <div className="dip-scroll"><table className="dip-log">
            <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Detail</th></tr></thead>
            <tbody>{game.logs.map(entry => <tr key={entry.id} className={entry.kind === 'error' ? 'is-failed' : ''}><td>{entry.at}</td><td>{entry.event}</td><td><code>{entry.detail}</code></td></tr>)}</tbody></table></div>}
        </main>
      : state ? <GameView game={game} map={<>{map}{credit}</>} onPlay={() => go('play')} />
      : <GamesHome game={game} map={<>{map}{credit}</>} />}
  </Shell>;
}

function gameStateFromSnapshot(liveState: GameState, report: PublicPhaseReport, snapshot: PublicBoardSnapshot): GameState {
  return {
    ...liveState, year: report.year, season: report.season, phase: report.phase, units: structuredClone(snapshot.units),
    territories: Object.fromEntries(Object.entries(liveState.territories).map(([territory, value]) => [territory, { ...value, owner: snapshot.territoryOwners[territory] }])),
  };
}
