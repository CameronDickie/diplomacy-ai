import { useEffect, useMemo, useState } from 'react';
import { ALL_POWERS, TERRITORIES, type ChallengeLegalCatalog, type Power } from '@diplomacy/shared';
import { phaseTitle, title } from '../challenge/text.js';
import { useOrderEntry } from '../challenge/useOrderEntry.js';
import { heldTerritories, territoryName } from '../lib/game.js';
import { MapGraph } from '../ui/MapGraph.js';
import { lineColor } from './CenterChart.js';
import { fullGamesApi, type LiveGame } from './FullGames.js';
import { MODEL_NAMES, modelOf } from './record.js';

const ignore = () => undefined;

/**
 * Your seat in a full game. Each orders turn: the models write first (to you too), you write to anyone you
 * like, the models reply, then you give your orders while they decide theirs. Retreats and builds ask only
 * for your orders. The game waits for you; nothing is sent until you press a button.
 */
export function SeatPanel({ game, onChanged }: { game: LiveGame; onChanged: () => void }) {
  const seat = game.settings.seat!, board = game.current, waiting = game.live.waitingFor;
  const phase = game.record.phases.find(p => p.phaseId === waiting?.phaseId) ?? game.record.phases.find(p => !p.report);
  // This turn's messages that involve you, in the order they were written: the models' first messages, yours, their replies.
  const order = (m: { from: Power; round: string }) => m.round === 'REPLY' ? 2 : m.from === seat ? 1 : 0;
  const mine = (phase?.talk ?? []).flatMap(t => t.messages.map(m => ({ from: t.power, to: m.to, body: m.body, round: t.round })))
    .filter(m => m.from === seat || m.to === seat).sort((a, b) => order(a) - order(b));
  const others = ALL_POWERS.filter(p => p !== seat && board.units.some(u => u.power === p));
  const [drafts, setDrafts] = useState<Partial<Record<Power, string>>>({});
  const [legal, setLegal] = useState<ChallengeLegalCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const ordering = waiting?.kind === 'ACT';
  useEffect(() => { setDrafts({}); setConfirming(false); setError(null); }, [waiting?.phaseId, waiting?.kind]);
  useEffect(() => {
    setLegal(null);
    if (ordering && board.phase === 'ORDERS') void fullGamesApi.legal(game.run.runId).then(setLegal).catch(e => setError((e as Error).message));
  }, [ordering, waiting?.phaseId]);
  // The challenge's own order entry: legal options per unit, convoy pairing, retreats and builds.
  const attemptLike = useMemo(() => ({ id: game.run.runId, phaseId: waiting?.phaseId ?? '', lifecycle: 'ACTIVE', execution: ordering ? 'ACCEPTING' : 'DECIDING', board }), [game.run.runId, waiting?.phaseId, ordering, board]);
  const entry = useOrderEntry(attemptLike as never, { humanPower: seat, board } as never, board.phase === 'ORDERS' ? legal : { attemptId: '', phaseId: '', revision: 0, options: [] }, busy, 'seat');
  const mapState = useMemo(() => ({ units: board.units, territories: Object.fromEntries(TERRITORIES.map(t => [t.id, { id: t.id, isSupplyCenter: t.isSupplyCenter, owner: board.territoryOwners[t.id] }])) }), [board]);
  const held = useMemo(() => heldTerritories(game.record.phases.flatMap(p => p.report ? [p.report] : []), board.units), [game.record.phases, board]);

  async function send(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); setConfirming(false); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const messages = others.filter(p => drafts[p]?.trim()).map(p => ({ to: p, body: drafts[p]!.trim() }));
  const status = !game.live.running ? 'The game is not being played. Continue it to take your turn.'
    : waiting?.kind === 'TALK' ? 'The other powers have written. Write to anyone you like, then send.'
    : ordering ? (board.phase === 'ORDERS' ? 'Choose your orders. The others are choosing theirs now.' : board.phase === 'RETREATS' ? 'Choose where your dislodged units retreat.' : 'Choose your builds or disbands.')
    : board.units.some(u => u.power === seat) ? 'The other powers are writing or deciding…' : 'You have been eliminated; the game plays on without you.';

  return <section className="dip-play viewer-seat" aria-label="Your turn">
    <section className="dip-map" aria-label={`Board now, ${phaseTitle(board)}`}>
      <MapGraph gameState={mapState} heldTerritories={held} selectedTerritory={ordering ? entry.selected as never : null} selectedUnit={ordering ? entry.selectedUnit : null}
        validTargets={[]} pendingOrders={ordering ? entry.chosenOrders : []} onSelectTerritory={territory => { if (ordering && entry.own.some(u => u.territory === territory)) entry.setSelected(now => now === territory ? null : territory); }}
        onClearSelection={ignore} />
      <a className="dip-map-credit" href="/legal.html">Map: Godip contributors · GPL-3.0</a>
    </section>
    <aside className="viewer-seat-panel">
      <div className="dip-turn">
        <p className="dip-meta"><span className="viewer-power"><i style={{ background: lineColor(seat) }} aria-hidden="true" />You are {title(seat)}</span></p>
        <h2>{phaseTitle(board)}</h2>
        <p role="status" className={`dip-small${waiting ? ' viewer-your-turn' : ''}`}>{status}</p>
      </div>
      {mine.length > 0 && <div className="viewer-block"><h3>This turn's messages</h3>
        {mine.map((m, i) => <div key={i} className="viewer-thread"><p>{m.from === seat ? <>You <span className="dip-muted">to</span> {title(m.to)}</> : <>{title(m.from)} <small className="dip-muted">{MODEL_NAMES[modelOf(game, m.from)]}</small> <span className="dip-muted">{m.round === 'REPLY' ? 'replied' : 'wrote'}</span></>}</p><blockquote>{m.body}</blockquote></div>)}</div>}
      {waiting?.kind === 'TALK' && <form className="viewer-block viewer-compose" onSubmit={e => { e.preventDefault(); void send(() => fullGamesApi.talk(game.run.runId, messages)); }}>
        <h3>Your messages</h3>
        <p className="dip-small dip-muted">One message to each power, at most 500 characters. Leave a box empty to say nothing to that power. Each will reply once.</p>
        {others.map(p => <label key={p}>{title(p)}{mine.some(m => m.from === p) ? ' (wrote to you)' : ''}
          <textarea rows={2} maxLength={500} value={drafts[p] ?? ''} onChange={e => setDrafts(d => ({ ...d, [p]: e.target.value }))} /></label>)}
        <button type="submit" className="dip-solid" disabled={busy}>{busy ? 'Sending…' : messages.length ? `Send ${messages.length} message${messages.length === 1 ? '' : 's'}` : 'Send nothing this turn'}</button>
      </form>}
      {ordering && <div className="viewer-block">
        <h3>Your orders</h3>
        {board.phase === 'ORDERS' && entry.active.map(u => <label key={u.id}>{title(u.type)} in {territoryName(u.territory)}
          <select disabled={busy || !legal} value={entry.choices[u.id] ?? entry.defaultOrder(u)} onChange={e => entry.choose(u, e.target.value)}>
            {!legal && <option value="">Loading legal orders…</option>}
            {entry.options.filter(o => o.unitTerritory === u.territory).map(o => <option key={o.id} value={o.id}>{o.description}</option>)}</select></label>)}
        {board.phase === 'RETREATS' && entry.own.filter(u => u.mustRetreat).map(u => <label key={u.id}>Retreat from {territoryName(u.territory)}
          <select disabled={busy} value={entry.retreats[u.id] ?? ''} onChange={e => entry.setRetreats(v => ({ ...v, [u.id]: e.target.value }))}><option value="">Disband</option>
            {u.retreatOptions.flatMap(t => u.retreatCoasts[t]?.length ? u.retreatCoasts[t]!.map(c => `${t}/${c}`) : [t]).map(d => <option key={d} value={d}>{d}</option>)}</select></label>)}
        {board.phase === 'BUILDS' && <>
          <p className="dip-small">{entry.buildDelta >= 0 ? `Up to ${entry.buildDelta} build${entry.buildDelta === 1 ? '' : 's'}; unused builds are waived.` : `Choose ${-entry.buildDelta} unit${entry.buildDelta === -1 ? '' : 's'} to disband.`}</p>
          {entry.buildDelta > 0 ? entry.homes.map(h => <label key={h.id}>Build in {h.name}<select disabled={busy} value={entry.builds[h.id] ?? ''} onChange={e => entry.setBuilds(v => ({ ...v, [h.id]: e.target.value }))}>
            <option value="">No build</option><option value="ARMY">Army</option>{h.type !== 'LAND' && (h.coasts.length ? h.coasts.map(c => <option key={c} value={`FLEET/${c}`}>Fleet · {c} coast</option>) : <option value="FLEET">Fleet</option>)}</select></label>)
            : entry.own.map(u => <label key={u.id} className="dip-check"><input type="checkbox" disabled={busy} checked={entry.disbands.includes(u.id)}
              onChange={e => entry.setDisbands(v => e.target.checked ? [...v, u.id] : v.filter(id => id !== u.id))} />{title(u.type)} in {territoryName(u.territory)}</label>)}</>}
        {entry.convoyWarnings.map(w => <p className="dip-notice" key={w}>{w}</p>)}
        {confirming ? <div className="viewer-live-actions"><span className="dip-small">Submit these orders? They cannot be changed afterwards.</span>
          <button type="button" className="dip-solid" disabled={busy || !entry.complete} onClick={() => { const action = entry.submission(); if (action) void send(() => fullGamesApi.act(game.run.runId, action)); }}>{busy ? 'Submitting…' : 'Yes, submit'}</button>
          <button type="button" className="dip-link" onClick={() => setConfirming(false)}>Keep editing</button></div>
          : <button type="button" className="dip-solid" disabled={busy || !entry.complete} onClick={() => setConfirming(true)}>Submit orders</button>}
      </div>}
      {error && <p className="dip-notice is-error" role="alert">{error}</p>}
    </aside>
  </section>;
}
