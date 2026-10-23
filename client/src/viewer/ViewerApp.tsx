import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ALL_POWERS, TERRITORIES, type AutoplayGameFile, type AutoplayIndexEntry, type Power } from '@diplomacy/shared';
import { Shell, type NavItem } from '../challenge/Shell.js';
import { phaseTitle, title } from '../challenge/text.js';
import { heldTerritories } from '../lib/game.js';
import { MapGraph } from '../ui/MapGraph.js';
import { CenterChart } from './CenterChart.js';
import { MODEL_NAMES, eliminations, modelKey, modelOf, orderMix, turnsOf, usd, type ModelKey } from './record.js';
import { TurnPanel, type Tab } from './TurnPanel.js';
import { Budgets, LiveControls, NewGameForm, fullGamesApi, type FullGamesList, type LiveGame } from './FullGames.js';
import { SeatPanel } from './Seat.js';
import './viewer.css';

/**
 * The address names what is shown, so a turn can be linked to directly: `#/live-4-holdrule/120` is a saved
 * record, `#/db/game-2026-10-18/12` a game in the database (live while it is being played), `#/new` the form.
 */
const fromHash = () => {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'new') return { kind: 'new' as const, run: null, at: null };
  if (parts[0] === 'db') return { kind: 'db' as const, run: parts[1] || null, at: parts[2] === undefined ? null : Number(parts[2]) };
  return { kind: 'record' as const, run: parts[0] || null, at: parts[1] === undefined ? null : Number(parts[1]) };
};
const ignore = () => undefined;
const ENDED: Record<string, string> = { SOLO_WIN: 'a solo win', LAST_YEAR: 'reaching its last year', STALEMATE: 'stalemate' };
const POLL_MS = 3000;

function modelsLine(assignment: Record<Power, string>) {
  const by = new Map<ModelKey, Power[]>();
  for (const p of ALL_POWERS) by.set(modelKey(assignment[p]), [...(by.get(modelKey(assignment[p])) ?? []), p]);
  return [...by].map(([m, powers]) => `${MODEL_NAMES[m]}: ${powers.map(title).join(', ')}`).join(' · ');
}

/**
 * AI games, part of Games: full games played by models, and games a person plays against them. Saved records
 * come from `game-records/`. Games in the autoplay database come from the full-games service, which also
 * starts, stops and continues them, so a game can be watched, or played, as it happens.
 */
export function ViewerApp() {
  const [route, setRoute] = useState(fromHash);
  const [index, setIndex] = useState<AutoplayIndexEntry[] | null>(null);
  const [list, setList] = useState<FullGamesList | null>(null);
  const [loaded, setLoaded] = useState({ records: false, db: false });
  const [game, setGame] = useState<AutoplayGameFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const on = () => setRoute(fromHash()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const refreshList = () => fullGamesApi.list().then(setList).catch(() => setList(null)).finally(() => setLoaded(l => ({ ...l, db: true })));
  useEffect(() => {
    fetch('/game-records/index.json').then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((body: { games: AutoplayIndexEntry[] }) => setIndex(body.games)).catch(() => setIndex([])).finally(() => setLoaded(l => ({ ...l, records: true })));
    void refreshList();
  }, []);
  // The list follows a game being played.
  useEffect(() => { if (!list?.running) return; const timer = window.setInterval(() => void refreshList(), POLL_MS * 2); return () => window.clearInterval(timer); }, [list?.running]);
  const entry = route.kind === 'record' ? index?.find(g => g.runId === route.run) ?? null : null;
  useEffect(() => {
    setGame(null);
    if (!entry) return;
    let live = true;
    fetch(`/game-records/${encodeURIComponent(entry.file)}`).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((body: AutoplayGameFile) => { if (live) setGame(body); }).catch(() => { if (live) setError(`Could not read ${entry.file}.`); });
    return () => { live = false; };
  }, [entry?.file]);

  const ready = loaded.records && loaded.db, current = route.kind === 'new' ? 'new' : route.run ? 'game' : 'library';
  const nav: NavItem[] = [{ id: 'library', label: 'AI games' }, ...(list ? [{ id: 'new', label: 'Play the AI' }] : []), ...(route.run ? [{ id: 'game', label: route.run }] : [])];
  return <Shell section="games" nav={nav} current={current} onNavigate={id => { window.location.hash = id === 'library' ? '' : id === 'new' ? '/new' : window.location.hash; }}>
    {error && <p className="dip-notice is-error" role="alert" style={{ marginTop: 16 }}>{error}</p>}
    {!ready && <p style={{ padding: '40px 0' }} role="status">Loading the games…</p>}
    {ready && route.kind === 'new' && (list ? <NewGameForm list={list} onStarted={runId => { void refreshList(); window.location.hash = `/db/${runId}`; }} />
      : <p style={{ padding: '40px 0' }}>Games against the AI are not offered on this server. <a href="#">See the AI games</a>.</p>)}
    {ready && route.kind !== 'new' && !route.run && <Library games={index ?? []} list={list} />}
    {ready && route.kind === 'record' && route.run && !entry && <p style={{ padding: '40px 0' }}>There is no saved record called {route.run}. <a href="#">See all games</a>.</p>}
    {entry && !game && !error && <p style={{ padding: '40px 0' }} role="status">Loading {entry.runId} ({(entry.bytes / 1e6).toFixed(1)} MB)…</p>}
    {game && route.kind === 'record' && <GameView game={game} at={route.at} />}
    {ready && route.kind === 'db' && route.run && <DatabaseGame key={route.run} runId={route.run} at={route.at} list={list} onChanged={() => void refreshList()} />}
  </Shell>;
}

/** A game in the database, refreshed while it is being played; Stop and Continue above the usual view. */
function DatabaseGame({ runId, at, list, onChanged }: { runId: string; at: number | null; list: FullGamesList | null; onChanged: () => void }) {
  const [game, setGame] = useState<LiveGame | null>(null);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fullGamesApi.game(runId).then(g => { if (live) { setGame(g); setMissing(false); } }).catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [runId, tick]);
  // While it is being played (or about to be), ask again every few seconds.
  const watching = !game || game.live.running || list?.running === runId;
  // When the game stops, the list (which decides whether another can start) catches up at once.
  const running = game?.live.running;
  useEffect(() => { if (running === false) onChanged(); }, [running]);
  useEffect(() => { if (!watching) return; const timer = window.setTimeout(() => setTick(t => t + 1), POLL_MS); return () => window.clearTimeout(timer); }, [watching, tick]);
  if (missing && !watching) return <p style={{ padding: '40px 0' }}>There is no game called {runId} in the database. <a href="#">See all games</a>.</p>;
  if (!game) return <p style={{ padding: '40px 0' }} role="status">Waiting for {runId}'s first phase…</p>;
  const changed = () => { onChanged(); setTick(t => t + 1); };
  // A seated game shows your turn above the usual view while it is being played.
  const controls = <><LiveControls game={game} list={list} onChanged={changed} />{game.settings.seat && game.live.running && <SeatPanel game={game} onChanged={changed} />}</>;
  // While you hold a seat in a game that has not ended, show only what every player may see.
  const player = game.settings.seat && game.status !== 'FINISHED' ? game.settings.seat : undefined;
  return game.record.phases.some(p => p.report) ? <GameView game={game} at={at} follow={game.live.running} prefix="db" controls={controls} player={player} />
    : <main id="dip-content"><div className="dip-heading">{player ? <><p className="dip-meta">Your game against the AI · {runId}</p><h1>{title(player)} <span>against the AI</span></h1></> : <h1>{runId}</h1>}</div>
      {controls}<p className="dip-muted">{player ? 'The first turn’s results will appear here.' : 'No phase has been played yet.'}</p></main>;
}

type Row = { runId: string; record?: AutoplayIndexEntry; db?: FullGamesList['games'][number] };
/**
 * Every AI game once: a saved record and the same game in this server's database are one row, opened live
 * from the database when it is there. Games you play a seat in come first, then the rest, newest first.
 */
function Library({ games, list }: { games: AutoplayIndexEntry[]; list: FullGamesList | null }) {
  const rows = new Map<string, Row>();
  for (const record of games) rows.set(record.runId, { runId: record.runId, record });
  for (const db of list?.games ?? []) rows.set(db.runId, { ...rows.get(db.runId), runId: db.runId, db });
  const rank = (r: Row) => r.db?.waiting ? 3 : r.db?.running ? 2 : r.db ? 1 : 0;
  const all = [...rows.values()].sort((a, b) => rank(b) - rank(a) || (b.db?.updatedAt ?? 0) - (a.db?.updatedAt ?? 0));
  const yours = all.filter(r => r.db?.seat), others = all.filter(r => !r.db?.seat);
  return <main id="dip-content">
    <div className="dip-heading"><p className="dip-meta">Games</p><h1>AI <span>games</span></h1>
      <p>Full games played by AI models. Open one to step through it turn by turn: the board, every order and its result, and the messages the powers sent each other.</p>
      {list && <a className="dip-solid viewer-new" href="#/new">Play against the AI</a>}</div>
    {yours.length > 0 && <section className="dip-section"><h2>Your games against the AI</h2><Rows rows={yours} /></section>}
    <section className="dip-section"><h2>{yours.length ? 'AI against AI' : 'All games'}</h2>
      {others.length === 0 ? <p className="dip-muted">No games yet.{list ? ' Start one with Play against the AI, or run npm run records -- collect autoplay-*.json to add recorded games.' : ''}</p> : <Rows rows={others} />}
    </section>
    {list && <p className="dip-small dip-muted viewer-funding">This server: <Budgets list={list} inline /></p>}
  </main>;
}

function Rows({ rows }: { rows: Row[] }) {
  return <ul className="dip-list viewer-games">{rows.map(({ runId, record, db }) => {
    const centers = db?.centers ?? record!.centers, top = ALL_POWERS.reduce((a, b) => centers[b] > centers[a] ? b : a);
    const active = db ? db.lifecycle === 'ACTIVE' : record!.status !== 'FINISHED';
    const status = db?.waiting ? 'Waiting for you' : db?.running ? 'Being played' : active ? 'Paused' : record?.endedBy ? `Ended by ${ENDED[record.endedBy] ?? 'finishing'}` : 'Finished';
    const reached = db ? `${title(db.season)} ${db.year}` : `${title(record!.reached.split(' ')[0])} ${record!.reached.split(' ')[1]}`;
    const result = centers[top] >= 18 ? `${title(top)} won with ${centers[top]}` : `${title(top)} ${active ? 'leads' : 'finished first'} with ${centers[top]}`;
    const href = db ? `#/db/${runId}` : `#/${runId}`;
    return <li key={runId}><span><a href={href}><strong>{runId}</strong></a>
      {record && <small>{modelsLine(record.assignment)}</small>}
      <small>{db?.seat ? `You play ${title(db.seat)} · ` : ''}{db?.standIn ? 'Stand-in models · ' : ''}{status} · {reached} · {result}
        {record ? ` · ${record.phases} phases · ${usd(record.settledNanousd)}` : ''}{record?.instructionsHashes.length ? ` · instructions ${record.instructionsHashes.join(', ')}` : ''}{record && record.parts > 1 ? ` · ${record.parts} runs` : ''}</small></span>
      <a href={href}>{db?.waiting ? 'Play' : db?.running ? 'Watch' : 'Open'}</a></li>;
  })}</ul>;
}

/** `follow`: a game being played; the view moves to each new phase as it arrives if it was showing the latest. */
/**
 * `player`: the power a person is playing in this unfinished game. Only what every player may see is shown:
 * the board and each turn's resolved orders, but no private notes, no messages between other powers and no
 * call details; they appear once the game ends.
 */
function GameView({ game, at, follow = false, prefix, controls, player }: { game: AutoplayGameFile; at: number | null; follow?: boolean; prefix?: string; controls?: ReactNode; player?: Power }) {
  const turns = useMemo(() => turnsOf(game), [game]);
  const mix = useMemo(() => orderMix(game, turns), [game, turns]);
  const out = useMemo(() => eliminations(turns), [turns]);
  // A game being played opens on its latest turn; anything else on its first, unless the address names one.
  const [index, setIndex] = useState(() => Math.max(0, Math.min(turns.length - 1, at ?? (follow ? turns.length - 1 : 0))));
  const [result, setResult] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [animation, setAnimation] = useState(0);
  // The chosen tab stays chosen while stepping, so a conversation can be followed turn by turn.
  const [tab, setTab] = useState<Tab>('orders');
  const turn = turns[index];
  const go = (next: number, showResult = false) => { setIndex(Math.max(0, Math.min(turns.length - 1, next))); setResult(showResult); setAnimation(a => a + 1); };
  // Keeps the address on the shown turn without filling the browser history.
  useEffect(() => { window.history.replaceState(null, '', `#/${prefix ? `${prefix}/` : ''}${game.run.runId}/${index}`); }, [index, game.run.runId]);
  const seen = useRef(turns.length);
  useEffect(() => { if (follow && index >= seen.current - 1 && turns.length > seen.current) go(turns.length - 1, true); seen.current = turns.length; }, [turns.length]);
  useEffect(() => { if (at !== null && at !== index) go(at); }, [at]);
  useEffect(() => {
    if (!playing) return;
    if (result && index >= turns.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => { if (!result) { setResult(true); setAnimation(a => a + 1); } else go(index + 1); }, (result ? 700 : 1100) / speed);
    return () => window.clearTimeout(timer);
  }, [playing, result, index, speed]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof Element && event.target.closest('input, select, textarea, button, a, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="slider"], [role="spinbutton"], [role="textbox"], [role="combobox"], [role="listbox"], [tabindex]')) return;
      if (event.key === 'ArrowRight') { setPlaying(false); go(index + 1); } else if (event.key === 'ArrowLeft') { setPlaying(false); go(index - 1); }
      else if (event.key === ' ') { event.preventDefault(); setPlaying(p => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index]);

  const shown = result ? turn.report.after : turn.report.before;
  const mapState = useMemo(() => ({ units: shown.units, territories: Object.fromEntries(TERRITORIES.map(t => [t.id, { id: t.id, isSupplyCenter: t.isSupplyCenter, owner: shown.territoryOwners[t.id] }])) }), [shown]);
  const orders = turn.report.phase === 'ORDERS' && !result ? turn.report.resolvedOrders : [];
  const reports = useMemo(() => turns.map(t => t.report), [turns]);
  const held = useMemo(() => heldTerritories(reports.slice(0, index), shown.units), [reports, index, shown]);
  return <main id="dip-content">
    {player ? <div className="dip-heading viewer-heading"><p className="dip-meta">Your game against the AI · {game.run.runId}{game.run.transport === 'live' ? '' : ' · stand-in models'}</p>
      <h1>{title(player)} <span>against the AI</span></h1>
      <p>{modelsLine(game.run.assignment)}. {title(game.summary.season)} {game.summary.year}, after {turns.length} phase{turns.length === 1 ? '' : 's'}{game.run.transport === 'live' ? `; the AI has cost ${usd(game.summary.settledNanousd)} so far` : ''}.</p></div>
    : <div className="dip-heading viewer-heading"><p className="dip-meta">{game.run.transport === 'live' ? 'Live models' : 'Stand-in models'}{game.status === 'FINISHED' ? ` · ended by ${ENDED[game.endedBy ?? ''] ?? 'finishing'}` : controls ? '' : ` · ${game.status.toLowerCase()}`}</p>
      <h1>{game.run.runId}</h1>
      <p>{modelsLine(game.run.assignment)}. {game.summary.winner ? `${title(game.summary.winner)} won` : 'No winner'} in {title(game.summary.season)} {game.summary.year} after {turns.length} phases, for {usd(game.summary.settledNanousd)}.</p></div>}
    {controls}
    <CenterChart game={game} turns={turns} index={index} onSelect={i => { setPlaying(false); go(i, true); }} />
    <div className="viewer-stepper" role="group" aria-label="Turn controls">
      <strong>{phaseTitle(turn.report)} <span className="dip-muted">· {turn.report.phase === 'ORDERS' ? (result ? 'result' : 'orders') : (result ? 'after' : 'before')}</span></strong>
      <button type="button" onClick={() => { setPlaying(false); go(index - 1); }} disabled={index === 0}>Previous</button>
      <button type="button" onClick={() => { setPlaying(false); if (result) go(index, false); else { setResult(true); setAnimation(a => a + 1); } }}>{result ? 'Show orders' : 'Show result'}</button>
      <button type="button" onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</button>
      <button type="button" onClick={() => { setPlaying(false); go(index + 1); }} disabled={index === turns.length - 1}>Next</button>
      <select aria-label="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
        <option value={0.5}>Half speed</option><option value={1}>Normal speed</option><option value={3}>Fast</option><option value={8}>Very fast</option></select>
      <input type="range" aria-label="Phase" min={0} max={turns.length - 1} value={index} onChange={e => { setPlaying(false); go(Number(e.target.value), true); }} />
    </div>
    <div className="dip-play viewer-play">
      <section className="dip-map" aria-label={`Board, ${phaseTitle(turn.report)}`}>
        <MapGraph gameState={mapState} heldTerritories={held} selectedTerritory={null} selectedUnit={null} validTargets={[]} pendingOrders={orders}
          replayStandoffs={result && turn.report.phase === 'ORDERS' ? turn.report.standoffTerritories : []}
          unitAnimationFrom={result ? turn.report.before.units : undefined} unitAnimationKey={result ? `${turn.report.id}-${animation}` : null}
          onSelectTerritory={ignore} onClearSelection={ignore} />
        <a className="dip-map-credit" href="/legal.html">Map: Godip contributors · GPL-3.0</a>
      </section>
      <TurnPanel game={game} turn={turn} tab={player ? 'orders' : tab} onTab={setTab} player={player} />
    </div>
    {player ? <p className="dip-muted dip-small viewer-player-note">While you play {title(player)}, this shows only what every player can see: the board and each turn's resolved orders. The other powers' messages to each other, their private notes and the call details appear when the game ends.</p>
    : <section className="dip-section viewer-facts" aria-label="The whole game">
      <h2>The whole game</h2>
      <div className="dip-scroll"><table className="dip-log">
        <thead><tr><th scope="col">Model</th><th scope="col">Orders</th><th scope="col">Hold</th><th scope="col">Move</th><th scope="col">Support</th><th scope="col">Convoy</th></tr></thead>
        <tbody>{(Object.entries(mix) as Array<[ModelKey, (typeof mix)[ModelKey]]>).map(([m, v]) => <tr key={m}><td>{MODEL_NAMES[m]}</td><td>{v.total}</td>
          {(['HOLD', 'MOVE', 'SUPPORT', 'CONVOY'] as const).map(k => <td key={k}>{Math.round(100 * v[k] / Math.max(1, v.total))}%</td>)}</tr>)}</tbody></table></div>
      <dl className="dip-facts">
        <div><dt>Eliminated</dt><dd className="viewer-out">{ALL_POWERS.some(p => out[p] !== undefined) ? ALL_POWERS.filter(p => out[p] !== undefined).map(p =>
          <button key={p} type="button" className="dip-link" onClick={() => go(out[p]!, true)}>{title(p)} {turns[out[p]!].report.year}</button>) : 'Nobody'}</dd></div>
        <div><dt>Peak</dt><dd>{(() => { const best = ALL_POWERS.map(p => ({ p, n: Math.max(...turns.map(t => t.centers[p])) })).sort((a, b) => b.n - a.n)[0]; return `${title(best.p)}, ${best.n} centers`; })()}</dd></div>
        <div><dt>Calls</dt><dd>{game.summary.calls} decisions · {game.summary.talkCalls} message calls</dd></div>
        <div><dt>Failures recorded</dt><dd>{game.record.failures.length}{game.parts && game.parts.length > 1 ? ` over ${game.parts.length} runs` : ''}</dd></div>
        <div><dt>Instructions</dt><dd>{game.run.harness ? <code>{game.run.harness.instructionsHash}</code> : 'not stamped (earlier wording)'}</dd></div>
        <div><dt>Shown</dt><dd>Phase {index + 1} of {turns.length}</dd></div>
      </dl>
      <p className="dip-muted dip-small">Keys: left and right arrows step through phases, space plays and pauses. Click or drag on the chart to jump.</p>
    </section>}
  </main>;
}
