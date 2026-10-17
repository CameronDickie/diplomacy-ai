import { useEffect, useMemo, useState } from 'react';
import { ALL_POWERS, TERRITORIES, type ChallengeLegalCatalog, type Power } from '@diplomacy/shared';
import { phaseTitle, title } from '../challenge/text.js';
import { useOrderEntry } from '../challenge/useOrderEntry.js';
import { heldTerritories, territoryName } from '../lib/game.js';
import { MapGraph } from '../ui/MapGraph.js';
import { lineColor } from './CenterChart.js';
import { fullGamesApi, type LiveGame } from './FullGames.js';
import { MODEL_NAMES, modelOf } from './record.js';

const NO_OPTIONS = { attemptId: '', phaseId: '', revision: 0, options: [] };
const turnOf = (phaseId: string) => { const [year, season] = phaseId.split(':').slice(-3); return `${title(season)} ${year}`; };
type Line = { phaseId: string; from: Power; to: Power; body: string; round: 'ASK' | 'REPLY' };

/** State kept in this browser for one game (what you have read, unsent drafts), so a reload keeps it. */
function useStored<T>(key: string, initial: T): [T, (update: (value: T) => T) => void] {
  const [value, setValue] = useState<T>(() => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : initial; } catch { return initial; } });
  const update = (change: (value: T) => T) => setValue(old => { const next = change(old); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* not kept */ } return next; });
  return [value, update];
}

/**
 * Your seat in a full game. Each orders turn: the models write first (to you too), you write to anyone you
 * like, the models reply, then you give your orders while they decide theirs. Retreats and builds ask only
 * for your orders. Messages are a chat per power, holding everything said between you over the game; orders
 * can be planned while you write and are submitted once the replies are in. Nothing is sent until you press
 * a button, and the game waits for you.
 */
export function SeatPanel({ game, onChanged }: { game: LiveGame; onChanged: () => void }) {
  const seat = game.settings.seat!, board = game.current, waiting = game.live.waitingFor;
  const boardKey = `${board.year}:${board.season}:${board.phase}`;
  const current = waiting?.phaseId ?? game.record.phases.find(p => !p.report)?.phaseId ?? '';
  const others = ALL_POWERS.filter(p => p !== seat), alive = others.filter(p => board.units.some(u => u.power === p));
  // Every message between you and another power, in the order it was written: each turn the models' first
  // messages, then yours, then their replies.
  const lines = useMemo(() => {
    const rank = (l: Line) => l.round === 'REPLY' ? 2 : l.from === seat ? 1 : 0;
    return game.record.phases.flatMap((p, i) => (p.talk ?? []).flatMap(t => t.messages.map(m => ({ phaseId: p.phaseId, from: t.power, to: m.to, body: m.body, round: t.round, i }))))
      .filter(l => l.from === seat || l.to === seat).sort((a, b) => a.i - b.i || rank(a) - rank(b));
  }, [game.record.phases, seat]);
  const thread = (p: Power) => lines.filter(l => l.from === p || l.to === p);
  const wroteNow = (p: Power) => lines.some(l => l.phaseId === current && l.from === p);

  const [tab, setTab] = useState<'messages' | 'orders'>('messages');
  const [open, setOpen] = useState<Power | null>(null);
  const [seen, setSeen] = useStored<Partial<Record<Power, number>>>(`viewer-seat-seen:${game.run.runId}`, {});
  const [stored, setDrafts] = useStored<{ turn: string; text: Partial<Record<Power, string>> }>(`viewer-seat-drafts:${game.run.runId}`, { turn: boardKey, text: {} });
  // Drafts belong to one turn; a new turn starts with none.
  const drafts = stored.turn === boardKey ? stored.text : {};
  const draft = (p: Power, text: string) => setDrafts(d => ({ turn: boardKey, text: { ...(d.turn === boardKey ? d.text : {}), [p]: text } }));
  const [legal, setLegal] = useState<{ key: string; catalog: ChallengeLegalCatalog } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const talking = waiting?.kind === 'TALK', ordering = waiting?.kind === 'ACT';
  // Each step opens where it is answered; you can still switch.
  useEffect(() => { if (talking) setTab('messages'); else if (ordering) setTab('orders'); setConfirming(false); setError(null); }, [waiting?.kind, waiting?.phaseId]);
  const openCount = open ? thread(open).length : 0;
  useEffect(() => { if (open && (seen[open] ?? 0) !== openCount) setSeen(s => ({ ...s, [open]: openCount })); }, [open, openCount]);
  // Legal orders load as soon as the game is waiting for you in an orders turn, so you can plan while you write.
  useEffect(() => {
    if (!waiting || board.phase !== 'ORDERS' || legal?.key === boardKey) return;
    let live = true;
    void fullGamesApi.legal(game.run.runId).then(catalog => { if (live) setLegal({ key: boardKey, catalog }); }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [boardKey, Boolean(waiting)]);
  const catalog = board.phase === 'ORDERS' ? (legal?.key === boardKey ? legal.catalog : null) : NO_OPTIONS;
  // The challenge's own order entry: legal options per unit, convoy pairing, retreats and builds. Choices are
  // kept from the messages to the orders step, since both belong to the same phase.
  const attemptLike = useMemo(() => ({ id: game.run.runId, phaseId: boardKey, lifecycle: 'ACTIVE', execution: ordering ? 'ACCEPTING' : 'DECIDING', board }), [game.run.runId, boardKey, ordering, board]);
  const entry = useOrderEntry(attemptLike as never, { humanPower: seat, board } as never, catalog, busy, 'seat');
  // On the map: click one of your units, then a place it can move to (directly or by convoy). Clicking the
  // unit again lets it go. Supports and convoys are chosen in the list.
  const movesOf = (territory: string) => entry.options.filter(o => o.unitTerritory === territory && ['MOVE', 'MOVE_VIA_CONVOY'].includes(o.id.split('|')[1]));
  const baseOf = (id: string) => id.split('|')[2].split('/')[0];
  const moveTargets = board.phase === 'ORDERS' && entry.selectedUnit ? [...new Set(movesOf(entry.selectedUnit.territory).map(o => baseOf(o.id)))] as never[] : [];
  function clickMap(territory: string) {
    if (entry.active.some(u => u.territory === territory)) { setTab('orders'); entry.setSelected(now => now === territory ? null : territory); return; }
    const unit = entry.selectedUnit;
    if (!unit || board.phase !== 'ORDERS') return;
    const moves = movesOf(unit.territory).filter(o => baseOf(o.id) === territory);
    const pick = moves.find(o => o.id.split('|')[1] === 'MOVE') ?? moves[0];
    if (pick) { entry.choose(unit, pick.id); entry.setSelected(null); }
  }
  const mapState = useMemo(() => ({ units: board.units, territories: Object.fromEntries(TERRITORIES.map(t => [t.id, { id: t.id, isSupplyCenter: t.isSupplyCenter, owner: board.territoryOwners[t.id] }])) }), [board]);
  const held = useMemo(() => heldTerritories(game.record.phases.flatMap(p => p.report ? [p.report] : []), board.units), [game.record.phases, board]);

  // A convoy only works with its fleet: an army sent by convoy with no fleet ordered to carry it is not submitted.
  const ready = entry.complete && entry.convoyWarnings.length === 0;
  async function send(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); setConfirming(false); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const messages = alive.filter(p => drafts[p]?.trim()).map(p => ({ to: p, body: drafts[p]!.trim() }));
  const unread = (p: Power) => p !== open && thread(p).length > (seen[p] ?? 0) && thread(p).slice(seen[p] ?? 0).some(l => l.from === p);
  const unreadCount = others.filter(unread).length;
  const out = !board.units.some(u => u.power === seat);
  const step = !game.live.running ? 'The game is not being played. Continue it to take your turn.'
    : out ? 'You have been eliminated; the game plays on without you.'
    : talking ? 'Your messages: write to anyone you like (one message to each power this turn), then send. You can plan your orders meanwhile.'
    : ordering ? (board.phase === 'ORDERS' ? 'Your orders: the replies are in. The others are choosing their orders now.' : board.phase === 'RETREATS' ? 'Your retreats: choose where your dislodged units go.' : 'Your builds: choose what to build or disband.')
    : 'The other powers are writing or deciding…';
  // Chats with news first, then powers you have talked to, then the rest.
  const order = [...others].sort((a, b) => Number(wroteNow(b)) - Number(wroteNow(a)) || thread(b).length - thread(a).length || ALL_POWERS.indexOf(a) - ALL_POWERS.indexOf(b));

  return <section className="dip-play viewer-seat" aria-label="Your turn">
    <section className="dip-map" aria-label={`Board now, ${phaseTitle(board)}`}>
      <MapGraph gameState={mapState} heldTerritories={held} selectedTerritory={entry.selected as never} selectedUnit={entry.selectedUnit}
        validTargets={moveTargets} pendingOrders={board.phase === 'ORDERS' ? entry.chosenOrders : []} onSelectTerritory={clickMap}
        onClearSelection={() => entry.setSelected(null)} />
      <a className="dip-map-credit" href="/legal.html">Map: Godip contributors · GPL-3.0</a>
    </section>
    <aside className="viewer-seat-panel">
      <div className="dip-turn">
        <p className="dip-meta"><span className="viewer-power"><i style={{ background: lineColor(seat) }} aria-hidden="true" />You are {title(seat)}</span></p>
        <h2>{phaseTitle(board)}</h2>
        <p role="status" className={`dip-small${waiting ? ' viewer-your-turn' : ''}`}>{step}</p>
      </div>
      <div className="viewer-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'messages'} onClick={() => setTab('messages')}>Messages{unreadCount ? ` (${unreadCount} new)` : ''}</button>
        <button type="button" role="tab" aria-selected={tab === 'orders'} onClick={() => setTab('orders')}>{board.phase === 'ORDERS' ? 'Orders' : board.phase === 'RETREATS' ? 'Retreats' : 'Builds'}{ordering ? ' · your move' : ''}</button>
      </div>

      {tab === 'messages' && !open && <ul className="viewer-chats">
        {order.map(p => { const all = thread(p), last = all[all.length - 1], gone = !alive.includes(p);
          return <li key={p}><button type="button" onClick={() => setOpen(p)} disabled={gone && !last}>
            <span className="viewer-chat-head"><span className="viewer-power"><i style={{ background: lineColor(p) }} aria-hidden="true" />{title(p)} <small>{MODEL_NAMES[modelOf(game, p)]}</small></span>
              <span className="viewer-chat-tags">{unread(p) && <b>New</b>}{wroteNow(p) && <em>Wrote this turn</em>}{drafts[p]?.trim() && <em>Draft</em>}{gone && <em>Out</em>}</span></span>
            <small className="viewer-chat-last">{last ? `${last.from === seat ? 'You: ' : ''}${last.body}` : talking && !gone ? 'Start a conversation' : 'No messages yet'}</small>
          </button></li>; })}
      </ul>}

      {tab === 'messages' && open && <div className="viewer-chat">
        <button type="button" className="dip-link" onClick={() => setOpen(null)}>← All chats</button>
        <h3><span className="viewer-power"><i style={{ background: lineColor(open) }} aria-hidden="true" />{title(open)} <small>{MODEL_NAMES[modelOf(game, open)]}</small></span></h3>
        <div className="viewer-chat-log" aria-live="polite">
          {thread(open).length === 0 && <p className="dip-muted dip-small">Nothing has been said between you yet.</p>}
          {thread(open).map((l, i, all) => <div key={i} className="viewer-chat-row">
            {(i === 0 || all[i - 1].phaseId !== l.phaseId) && <p className="viewer-chat-turn">{turnOf(l.phaseId)}</p>}
            <p className={`viewer-bubble${l.from === seat ? ' is-mine' : ''}`}>{l.body}</p></div>)}
        </div>
        {talking && alive.includes(open) ? <label className="viewer-chat-compose">Your message to {title(open)} this turn
          <textarea rows={3} maxLength={500} value={drafts[open] ?? ''} placeholder="One message per power each turn, up to 500 characters."
            onChange={e => draft(open, e.target.value)} />
          <small className="dip-muted">{(drafts[open] ?? '').length}/500 · sent together with your other messages below</small></label>
          : <p className="dip-small dip-muted">{!alive.includes(open) ? `${title(open)} is out of the game.` : 'You can write at the start of each orders turn, after the others have written.'}</p>}
      </div>}

      {tab === 'messages' && talking && <div className="viewer-send">
        <p className="dip-small">{messages.length ? `Ready to send to ${messages.map(m => title(m.to)).join(', ')}.` : 'No messages written yet; you can also send nothing this turn.'} Each power you write to replies once, then you give your orders.</p>
        <button type="button" className="dip-solid" disabled={busy} onClick={() => void send(() => fullGamesApi.talk(game.run.runId, messages))}>
          {busy ? 'Sending…' : messages.length ? `Send ${messages.length} message${messages.length === 1 ? '' : 's'}` : 'Send nothing this turn'}</button>
      </div>}

      {tab === 'orders' && <div className="viewer-block viewer-orders">
        {out ? <p className="dip-muted">You have no units.</p> : <>
          {!ordering && board.phase === 'ORDERS' && <p className="dip-small dip-muted">{talking ? 'Plan your orders while you write; they are kept. You can submit them once the replies are in.' : 'Your planned orders are kept until you can submit them.'}</p>}
          {board.phase === 'ORDERS' && entry.active.map(u => <label key={u.id}>{title(u.type)} in {territoryName(u.territory)}
            <select disabled={busy || !catalog} value={entry.choices[u.id] ?? entry.defaultOrder(u)} onChange={e => entry.choose(u, e.target.value)}>
              {!catalog && <option value="">{waiting ? 'Loading legal orders…' : 'Available when the game waits for you'}</option>}
              {entry.options.filter(o => o.unitTerritory === u.territory).map(o => <option key={o.id} value={o.id}>{o.description}</option>)}</select></label>)}
          {board.phase !== 'ORDERS' && !ordering && <p className="dip-small dip-muted">Nothing to decide yet.</p>}
          {board.phase === 'RETREATS' && ordering && entry.own.filter(u => u.mustRetreat).map(u => <label key={u.id}>Retreat from {territoryName(u.territory)}
            <select disabled={busy} value={entry.retreats[u.id] ?? ''} onChange={e => entry.setRetreats(v => ({ ...v, [u.id]: e.target.value }))}><option value="">Disband</option>
              {u.retreatOptions.flatMap(t => u.retreatCoasts[t]?.length ? u.retreatCoasts[t]!.map(c => `${t}/${c}`) : [t]).map(d => <option key={d} value={d}>{d}</option>)}</select></label>)}
          {board.phase === 'BUILDS' && ordering && <>
            <p className="dip-small">{entry.buildDelta >= 0 ? `Up to ${entry.buildDelta} build${entry.buildDelta === 1 ? '' : 's'}; unused builds are waived.` : `Choose ${-entry.buildDelta} unit${entry.buildDelta === -1 ? '' : 's'} to disband.`}</p>
            {entry.buildDelta > 0 ? entry.homes.map(h => <label key={h.id}>Build in {h.name}<select disabled={busy} value={entry.builds[h.id] ?? ''} onChange={e => entry.setBuilds(v => ({ ...v, [h.id]: e.target.value }))}>
              <option value="">No build</option><option value="ARMY">Army</option>{h.type !== 'LAND' && (h.coasts.length ? h.coasts.map(c => <option key={c} value={`FLEET/${c}`}>Fleet · {c} coast</option>) : <option value="FLEET">Fleet</option>)}</select></label>)
              : entry.own.map(u => <label key={u.id} className="dip-check"><input type="checkbox" disabled={busy} checked={entry.disbands.includes(u.id)}
                onChange={e => entry.setDisbands(v => e.target.checked ? [...v, u.id] : v.filter(id => id !== u.id))} />{title(u.type)} in {territoryName(u.territory)}</label>)}</>}
          {entry.convoyHint && <p className="dip-small dip-muted">No convoys are possible this turn. A fleet can carry an army only from a coast that touches the sea the fleet is in (for example, an army in Yorkshire with a fleet in the North Sea), and the fleet must be ordered to convoy it.</p>}
          {entry.convoyWarnings.map(w => <p className="dip-notice" key={w}>{w}</p>)}
          {ordering && entry.convoyWarnings.length > 0 && <p className="dip-small">Pair each convoy with its fleet before submitting.</p>}
          {ordering && (confirming ? <div className="viewer-live-actions"><span className="dip-small">Submit these orders? They cannot be changed afterwards.</span>
            <button type="button" className="dip-solid" disabled={busy || !ready} onClick={() => { const action = entry.submission(); if (action) void send(() => fullGamesApi.act(game.run.runId, action)); }}>{busy ? 'Submitting…' : 'Yes, submit'}</button>
            <button type="button" className="dip-link" onClick={() => setConfirming(false)}>Keep editing</button></div>
            : <button type="button" className="dip-solid" disabled={busy || !ready} onClick={() => setConfirming(true)}>Submit orders</button>)}
          {talking && board.phase === 'ORDERS' && <button type="button" className="dip-link" onClick={() => setTab('messages')}>Back to your messages</button>}
        </>}
      </div>}
      {error && <p className="dip-notice is-error" role="alert">{error}</p>}
    </aside>
  </section>;
}
