import { useEffect, useMemo, useRef, useState } from 'react';
import type { Coast, GameState, Order, PublicBoardSnapshot, PublicPhaseReport, TerritoryId, Unit } from '@diplomacy/shared';
import { HistoryView } from '../challenge/History.js';
import { Shell, useReveal, type NavItem } from '../challenge/Shell.js';
import { useAuth } from '../hooks/useAuth.js';
import { useGameSocket } from '../hooks/useGameSocket.js';
import { adjacentTerritories, convoyDestinations, convoyRoute, heldTerritories, TERRITORY_BY_ID, territoryName } from '../lib/game.js';
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
interface MapOrderMenuState { territory: TerritoryId; x: number; y: number }

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
  const [selectedTerritory, setSelectedTerritory] = useState<TerritoryId | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [seenMessages, setSeenMessages] = useState(0);
  const [replayReport, setReplayReport] = useState<PublicPhaseReport | null>(null);
  const [replayFrame, setReplayFrame] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replayRun, setReplayRun] = useState(0);
  const [mapOrderMenu, setMapOrderMenu] = useState<MapOrderMenuState | null>(null);
  const started = Boolean(state && state.status !== 'LOBBY');
  const isHost = Boolean(state && state.hostPlayerId === game.myPlayerId);
  const phaseKey = state ? `${state.year}-${state.season}-${state.phase}` : 'no-game';
  // The newest notification is shown above the page; bring it into view wherever the action was.
  const latestError = useReveal<HTMLDivElement>(game.errors[game.errors.length - 1]?.id);

  const closeReplay = () => { setReplayReport(null); setReplayPlaying(false); };
  useEffect(() => { const onHash = () => { setView(fromHash()); closeReplay(); setMapOrderMenu(null); }; window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  const go = (next: View) => { closeReplay(); setMapOrderMenu(null); if (fromHash() === next) setView(next); else window.location.hash = `/${next}`; };
  // The moment a game starts, everyone is taken to the map.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = state?.status ?? null;
    if (lastStatus.current === 'LOBBY' && status === 'IN_PROGRESS') go('play');
    lastStatus.current = status;
  }, [state?.status]);

  useEffect(() => { setPendingOrders([]); setMapOrderMenu(null); setSelectedTerritory(null); }, [phaseKey]);
  useEffect(() => {
    if (!replayReport || !replayPlaying) return;
    if (replayFrame >= 2) { setReplayPlaying(false); return; }
    const timer = window.setTimeout(() => setReplayFrame(frame => Math.min(2, frame + 1)), 1400 / replaySpeed);
    return () => window.clearTimeout(timer);
  }, [replayFrame, replayPlaying, replayReport, replaySpeed]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMapOrderMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  const displayedOrders = replayReport ? (replayReport.phase === 'ORDERS' && replayFrame === 1 ? replayReport.resolvedOrders : []) : playing ? pendingOrders : [];

  const selectedUnit = useMemo<Unit | null>(() => {
    if (!selectedTerritory || !state) return null;
    return state.units.find(unit => unit.territory === selectedTerritory && unit.power === game.myPower && !unit.mustRetreat) ?? null;
  }, [state, game.myPower, selectedTerritory]);
  const convoyLock = useMemo(
    () => selectedUnit ? pendingOrders.find(order => order.unitTerritory === selectedUnit.territory && order.type === 'CONVOY') ?? null : null,
    [pendingOrders, selectedUnit]);
  const directTargets = useMemo(() => selectedUnit && !convoyLock ? adjacentTerritories(selectedUnit) : [], [selectedUnit, convoyLock]);
  const convoyTargets = useMemo(() => selectedUnit && state && !convoyLock ? convoyDestinations(selectedUnit, state.units) : [], [state, selectedUnit, convoyLock]);
  const mapTargets = useMemo(() => [...new Set([...directTargets, ...convoyTargets])], [convoyTargets, directTargets]);
  const ordering = state?.status === 'IN_PROGRESS' && state.phase === 'ORDERS';

  function selectOnMap(territory: TerritoryId, point?: { x: number; y: number }) {
    const ownUnit = state?.units.find(unit => unit.territory === territory && unit.power === game.myPower && !unit.mustRetreat);
    if (ownUnit && ownUnit.id !== selectedUnit?.id) { setSelectedTerritory(territory); setMapOrderMenu(null); return; }
    if (selectedUnit && ordering) {
      setMapOrderMenu({ territory, x: point?.x ?? window.innerWidth / 2, y: point?.y ?? window.innerHeight / 2 });
      return;
    }
    // Outside an orders phase a second click on your unit deselects it, as in the challenge.
    if (ownUnit) { setSelectedTerritory(null); setMapOrderMenu(null); }
  }
  function clearMapSelection() { setSelectedTerritory(null); setMapOrderMenu(null); }
  function queue(nextOrders: Order[]) {
    const ordered = new Set(nextOrders.map(order => order.unitTerritory));
    setPendingOrders(orders => [...orders.filter(candidate => !ordered.has(candidate.unitTerritory)), ...nextOrders]);
    setMapOrderMenu(null);
  }
  const base = (unit: Unit) => ({ id: crypto.randomUUID(), power: unit.power, unitTerritory: unit.territory, unitCoast: unit.coast, supportedDestination: null });
  const hold = (unit: Unit): Order => ({ ...base(unit), type: 'HOLD', targetTerritory: null, targetCoast: null, supportedUnit: null });
  const move = (unit: Unit, territory: TerritoryId, coast: Coast | null, viaConvoy?: boolean): Order =>
    ({ ...base(unit), type: 'MOVE', targetTerritory: territory, targetCoast: coast, viaConvoy, supportedUnit: null });
  const convoy = (fleet: Unit, army: Unit, destination: TerritoryId): Order =>
    ({ ...base(fleet), type: 'CONVOY', targetTerritory: destination, targetCoast: null, supportedUnit: army.territory });
  function queueConvoyMove(unit: Unit, territory: TerritoryId) {
    const route = state ? convoyRoute(unit, state.units, territory) : [];
    if (route.length) queue([move(unit, territory, null, true), ...route.map(fleet => convoy(fleet, unit, territory))]);
  }
  function replay(report: PublicPhaseReport) { document.querySelector('.dip')?.scrollTo(0, 0); setReplayReport(report); setReplayFrame(0); setReplayPlaying(true); setReplayRun(run => run + 1); }

  const interactive = playing && Boolean(game.myPower);
  const map = <MapGraph
    gameState={displayedState}
    heldTerritories={held}
    selectedTerritory={interactive ? selectedTerritory : null}
    selectedUnit={interactive ? selectedUnit : null}
    validTargets={interactive && ordering ? mapTargets : []}
    pendingOrders={displayedOrders}
    replayStandoffs={replayReport?.phase === 'ORDERS' && replayFrame === 2 ? replayReport.standoffTerritories : []}
    unitAnimationFrom={replayReport && replayFrame === 2 ? replayReport.before.units : undefined}
    unitAnimationKey={replayReport && replayFrame === 2 ? `${replayReport.id}-${replayRun}` : null}
    onSelectTerritory={interactive ? selectOnMap : ignoreMapSelection}
    onClearSelection={clearMapSelection} />;
  const menu = interactive && mapOrderMenu && selectedUnit && ordering && state
    ? <MapOrderMenu menu={mapOrderMenu} selectedUnit={selectedUnit} directTargets={directTargets} convoyTargets={convoyTargets}
        occupiedUnit={state.units.find(unit => unit.territory === mapOrderMenu.territory && !unit.mustRetreat) ?? null}
        lockedConvoyOrder={convoyLock} onClose={() => setMapOrderMenu(null)} onDeselect={clearMapSelection}
        onHold={() => queue([hold(selectedUnit)])} onMove={coast => queue([move(selectedUnit, mapOrderMenu.territory, coast)])}
        onConvoyMove={() => queueConvoyMove(selectedUnit, mapOrderMenu.territory)} />
    : null;
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
      : current === 'play' && state ? <PlayView game={game} state={state} map={<>{map}{credit}{menu}</>} selectedUnit={selectedUnit} pendingOrders={pendingOrders}
          onSelectTerritory={territory => { setSelectedTerritory(territory); setMapOrderMenu(null); }} onPendingOrdersChange={setPendingOrders}
          onSubmitOrders={() => game.submitOrders(pendingOrders)} onGame={() => go('game')} onHistory={() => go('history')} />
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

/** What the selected unit can do with the province that was clicked. */
function MapOrderMenu({ menu, selectedUnit, directTargets, convoyTargets, occupiedUnit, lockedConvoyOrder, onClose, onDeselect, onHold, onMove, onConvoyMove }: {
  menu: MapOrderMenuState; selectedUnit: Unit; directTargets: TerritoryId[]; convoyTargets: TerritoryId[]; occupiedUnit: Unit | null; lockedConvoyOrder: Order | null;
  onClose: () => void; onDeselect: () => void; onHold: () => void; onMove: (coast: Coast | null) => void; onConvoyMove: () => void;
}) {
  const locked = Boolean(lockedConvoyOrder), here = menu.territory === selectedUnit.territory;
  const canMove = !locked && directTargets.includes(menu.territory), canConvoyMove = !locked && convoyTargets.includes(menu.territory);
  const coasts = canMove && selectedUnit.type === 'FLEET' ? TERRITORY_BY_ID[menu.territory]?.coasts ?? [] : [];
  const blocked = Boolean(occupiedUnit && occupiedUnit.power === selectedUnit.power && occupiedUnit.id !== selectedUnit.id);
  return <div className="dip-map-menu" role="dialog" aria-label={`Orders for ${territoryName(selectedUnit.territory)}`}
    style={{ left: Math.max(8, Math.min(menu.x + 10, window.innerWidth - 250)), top: Math.max(8, Math.min(menu.y + 10, window.innerHeight - 220)) }}>
    <header><strong>{selectedUnit.type === 'ARMY' ? 'Army' : 'Fleet'} · {territoryName(selectedUnit.territory)}</strong>
      <button type="button" className="dip-link dip-small" onClick={onClose}>Close</button></header>
    {!here && <p className="dip-muted dip-small">To {territoryName(menu.territory)}</p>}
    <div>
      {lockedConvoyOrder && <em>This fleet is convoying {territoryName(lockedConvoyOrder.supportedUnit!)} to {territoryName(lockedConvoyOrder.targetTerritory!)}.</em>}
      {!locked && here && <button type="button" onClick={onHold}>Hold</button>}
      {here && <button type="button" onClick={onDeselect}>Deselect</button>}
      {canMove && !blocked && coasts.length === 0 && <button type="button" onClick={() => onMove(null)}>Move here</button>}
      {canMove && !blocked && coasts.map(coast => <button type="button" onClick={() => onMove(coast)} key={coast}>Move to the {coast.toLowerCase()} coast</button>)}
      {canConvoyMove && !blocked && <button type="button" onClick={onConvoyMove}>Move here by convoy</button>}
      {blocked && <em>One of your own units is here.</em>}
      {!here && !canMove && !canConvoyMove && !locked && <em>This unit cannot move here. Supports and convoys are set in the orders panel.</em>}
    </div>
  </div>;
}
