import { useEffect, useMemo, useState } from 'react';
import { ALL_POWERS, TERRITORIES, type AutoplayGameFile, type AutoplayIndexEntry, type Power } from '@diplomacy/shared';
import { Shell, type NavItem } from '../challenge/Shell.js';
import { phaseTitle, title } from '../challenge/text.js';
import { MapGraph } from '../ui/MapGraph.js';
import { CenterChart } from './CenterChart.js';
import { MODEL_NAMES, eliminations, modelKey, modelOf, orderMix, turnsOf, usd, type ModelKey } from './record.js';
import { TurnPanel, type Tab } from './TurnPanel.js';
import './viewer.css';

/** `#/live-4-holdrule/120`: a game and a phase, so a turn can be linked to directly. */
const fromHash = () => { const [run, at] = window.location.hash.replace(/^#\/?/, '').split('/'); return { run: run || null, at: at === undefined ? null : Number(at) }; };
const ignore = () => undefined;
const ENDED: Record<string, string> = { SOLO_WIN: 'a solo win', LAST_YEAR: 'reaching its last year', STALEMATE: 'stalemate' };

function modelsLine(assignment: Record<Power, string>) {
  const by = new Map<ModelKey, Power[]>();
  for (const p of ALL_POWERS) by.set(modelKey(assignment[p]), [...(by.get(modelKey(assignment[p])) ?? []), p]);
  return [...by].map(([m, powers]) => `${MODEL_NAMES[m]}: ${powers.map(title).join(', ')}`).join(' · ');
}

/**
 * The game viewer (development only): full games played by models with no human, from the records
 * the autoplay tool exports. It reads `game-records/`, which only the development server serves.
 */
export function ViewerApp() {
  const [route, setRoute] = useState(fromHash);
  const [index, setIndex] = useState<AutoplayIndexEntry[] | null>(null);
  const [game, setGame] = useState<AutoplayGameFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const on = () => setRoute(fromHash()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  useEffect(() => {
    fetch('/game-records/index.json').then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((body: { games: AutoplayIndexEntry[] }) => setIndex(body.games))
      .catch(() => setError('No game records are available here. Run npm run records -- collect autoplay-*.json, then open this page from the development server (npm run dev).'));
  }, []);
  const entry = index?.find(g => g.runId === route.run) ?? null;
  useEffect(() => {
    setGame(null);
    if (!entry) return;
    let live = true;
    fetch(`/game-records/${encodeURIComponent(entry.file)}`).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((body: AutoplayGameFile) => { if (live) setGame(body); }).catch(() => { if (live) setError(`Could not read ${entry.file}.`); });
    return () => { live = false; };
  }, [entry?.file]);

  const nav: NavItem[] = [{ id: 'library', label: 'All games' }, ...(entry ? [{ id: 'game', label: entry.runId }] : [])];
  return <Shell section="viewer" nav={nav} current={entry ? 'game' : 'library'} onNavigate={id => { if (id === 'library') window.location.hash = ''; }}>
    {error && <p className="dip-notice is-error" role="alert" style={{ marginTop: 16 }}>{error}</p>}
    {!index && !error && <p style={{ padding: '40px 0' }} role="status">Loading the games…</p>}
    {index && !route.run && <Library games={index} />}
    {index && route.run && !entry && <p style={{ padding: '40px 0' }}>There is no game called {route.run}. <a href="#">See all games</a>.</p>}
    {entry && !game && !error && <p style={{ padding: '40px 0' }} role="status">Loading {entry.runId} ({(entry.bytes / 1e6).toFixed(1)} MB)…</p>}
    {game && <GameView game={game} at={route.at} />}
  </Shell>;
}

function Library({ games }: { games: AutoplayIndexEntry[] }) {
  return <main id="dip-content">
    <div className="dip-heading"><p className="dip-meta">Development only</p><h1>Game <span>viewer</span></h1>
      <p>Full games with a model on every power and no human player, as the autoplay tool recorded them. Pick one to step through it turn by turn.</p></div>
    {games.length === 0 ? <p className="dip-muted">The records folder is empty.</p> : <ul className="dip-list viewer-games">
      {games.map(g => {
        const top = ALL_POWERS.reduce((a, b) => g.centers[b] > g.centers[a] ? b : a);
        return <li key={g.runId}><span><a href={`#/${g.runId}`}><strong>{g.runId}</strong></a>
          <small>{modelsLine(g.assignment)}</small>
          <small>{g.status === 'FINISHED' ? `Ended by ${ENDED[g.endedBy ?? ''] ?? 'finishing'}` : g.status.toLowerCase()} · {title(g.reached.split(' ')[0])} {g.reached.split(' ')[1]} · {g.winner ? `${title(g.winner)} won` : `${title(top)} led with ${g.centers[top]}`}
            {' '}· {g.phases} phases · {usd(g.settledNanousd)}{g.instructionsHashes.length ? ` · instructions ${g.instructionsHashes.join(', ')}` : ' · before instructions were stamped'}{g.parts > 1 ? ` · ${g.parts} runs` : ''}</small></span>
          <a href={`#/${g.runId}`}>Open</a></li>;
      })}</ul>}
  </main>;
}

function GameView({ game, at }: { game: AutoplayGameFile; at: number | null }) {
  const turns = useMemo(() => turnsOf(game), [game]);
  const mix = useMemo(() => orderMix(game, turns), [game, turns]);
  const out = useMemo(() => eliminations(turns), [turns]);
  const [index, setIndex] = useState(() => Math.max(0, Math.min(turns.length - 1, at ?? 0)));
  const [result, setResult] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [animation, setAnimation] = useState(0);
  // The chosen tab stays chosen while stepping, so a conversation can be followed turn by turn.
  const [tab, setTab] = useState<Tab>('orders');
  const turn = turns[index];
  const go = (next: number, showResult = false) => { setIndex(Math.max(0, Math.min(turns.length - 1, next))); setResult(showResult); setAnimation(a => a + 1); };
  // Keeps the address on the shown turn without filling the browser history.
  useEffect(() => { window.history.replaceState(null, '', `#/${game.run.runId}/${index}`); }, [index, game.run.runId]);
  useEffect(() => { if (at !== null && at !== index) go(at); }, [at]);
  useEffect(() => {
    if (!playing) return;
    if (result && index >= turns.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => { if (!result) { setResult(true); setAnimation(a => a + 1); } else go(index + 1); }, (result ? 700 : 1100) / speed);
    return () => window.clearTimeout(timer);
  }, [playing, result, index, speed]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input, select, textarea')) return;
      if (event.key === 'ArrowRight') { setPlaying(false); go(index + 1); } else if (event.key === 'ArrowLeft') { setPlaying(false); go(index - 1); }
      else if (event.key === ' ') { event.preventDefault(); setPlaying(p => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index]);

  const shown = result ? turn.report.after : turn.report.before;
  const mapState = useMemo(() => ({ units: shown.units, territories: Object.fromEntries(TERRITORIES.map(t => [t.id, { id: t.id, isSupplyCenter: t.isSupplyCenter, owner: shown.territoryOwners[t.id] }])) }), [shown]);
  const orders = turn.report.phase === 'ORDERS' && !result ? turn.report.resolvedOrders : [];
  return <main id="dip-content">
    <div className="dip-heading viewer-heading"><p className="dip-meta">{game.run.transport === 'live' ? 'Live models' : 'Stand-in models'} · {game.status === 'FINISHED' ? `ended by ${ENDED[game.endedBy ?? ''] ?? 'finishing'}` : game.status.toLowerCase()}</p>
      <h1>{game.run.runId}</h1>
      <p>{modelsLine(game.run.assignment)}. {game.summary.winner ? `${title(game.summary.winner)} won` : 'No winner'} in {title(game.summary.season)} {game.summary.year} after {turns.length} phases, for {usd(game.summary.settledNanousd)}.</p></div>
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
        <MapGraph gameState={mapState} selectedTerritory={null} selectedUnit={null} validTargets={[]} pendingOrders={orders}
          replayStandoffs={result && turn.report.phase === 'ORDERS' ? turn.report.standoffTerritories : []}
          unitAnimationFrom={result ? turn.report.before.units : undefined} unitAnimationKey={result ? `${turn.report.id}-${animation}` : null}
          onSelectTerritory={ignore} onClearSelection={ignore} />
        <a className="dip-map-credit" href="/legal.html">Map: Godip contributors · GPL-3.0</a>
      </section>
      <TurnPanel game={game} turn={turn} tab={tab} onTab={setTab} />
    </div>
    <section className="dip-section viewer-facts" aria-label="The whole game">
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
    </section>
  </main>;
}
