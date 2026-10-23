import { Fragment, useEffect, useState } from 'react';
import type { Power } from '@diplomacy/shared';
import { territoryName } from '../lib/game.js';
import { CoastChoices } from './CoastChoices.js';
import { coastName, describeChoice, foreignOwner, placeName, title } from './text.js';
import type { OrderEntry } from './useOrderEntry.js';

/** Builds stay within the centers held beyond the units; disbands remove exactly the surplus. */
export function adjustmentsReady(entry: OrderEntry): boolean {
  if (entry.board?.phase !== 'BUILDS') return true;
  const built = Object.values(entry.builds).filter(Boolean).length;
  return entry.buildDelta >= 0 ? built <= entry.buildDelta : entry.disbands.length === -entry.buildDelta;
}

/**
 * One turn's decisions, the same wherever a person plays: the daily challenge, a seat against the AI and a
 * game with friends. Each unit has one menu of every order the rules allow, in words ("Support Munich
 * (Germany) into Burgundy"); its name selects it on the map. Retreats and builds follow the same pattern,
 * and builds lock once the allowance is used. The caller owns the submit action, since each game sends it
 * its own way.
 */
export function OrderControls({ entry, power, legalReady, loading, disabled, legalError, onRetryLegal, onActivity }: {
  entry: OrderEntry; power: Power;
  /** Whether the legal orders for an orders phase have arrived. */
  legalReady: boolean;
  /** What an order menu says until they have. */
  loading: string;
  disabled: boolean;
  legalError?: string | null; onRetryLegal?: () => void;
  /** Any change, for games that expire without activity. */
  onActivity?: () => void;
}) {
  const board = entry.board;
  // The selected unit's row in the list, and whether it is on screen: below the map on a phone it usually is not.
  const [row, setRow] = useState<HTMLElement | null>(null), [rowShown, setRowShown] = useState(true);
  useEffect(() => {
    if (!row || typeof IntersectionObserver === 'undefined') { setRowShown(true); return; }
    const watch = new IntersectionObserver(([seen]) => setRowShown(seen.isIntersecting), { threshold: 0.6 });
    watch.observe(row);
    return () => watch.disconnect();
  }, [row]);
  if (!board) return null;
  const touched = () => onActivity?.();
  const built = Object.values(entry.builds).filter(Boolean).length, mustDisband = Math.max(0, -entry.buildDelta);
  const owner = foreignOwner(board.units, power);
  const option = (o: { id: string }) => <option key={o.id} value={o.id}>{describeChoice(o.id, owner)}</option>;
  // After a tap on another place, the selected unit's menu holds only the orders involving it (and Hold, and
  // whatever is already chosen, so the menu never shows a value it does not list).
  const narrowed = (territory: string) => Boolean(entry.focus && entry.selected === territory);
  /** A unit's orders, grouped so a long list of supports reads at a glance: Hold, then moves, supports, convoys. */
  const menu = (territory: string): Array<[string | null, typeof entry.options]> => {
    const all = entry.options.filter(o => o.unitTerritory === territory), unit = entry.active.find(u => u.territory === territory);
    const chosen = unit ? entry.choices[unit.id] ?? entry.defaultOrder(unit) : '';
    const shown = narrowed(territory) ? all.filter(o => o.order.type === 'HOLD' || o.id === chosen || entry.involving(entry.focus!).includes(o)) : all;
    const kind = (o: typeof all[number]) => o.order.type === 'HOLD' ? null : o.order.type.startsWith('SUPPORT') ? 'Supports' : o.order.type === 'CONVOY' ? 'Convoys' : 'Moves';
    return ([null, 'Moves', 'Supports', 'Convoys'] as const).map(group => [group, shown.filter(o => kind(o) === group)] as [string | null, typeof all]).filter(([, items]) => items.length > 0);
  };
  return <div className="dip-orders">
    {legalError && <p className="dip-notice is-error" role="alert">Could not load legal orders: {legalError} {onRetryLegal && <button type="button" onClick={onRetryLegal}>Retry legal orders</button>}</p>}
    {board.phase === 'ORDERS' && <CoastChoices entry={entry} disabled={disabled} onChoose={touched} />}

    {board.phase === 'ORDERS' && entry.active.map(u => <div key={u.id} ref={entry.selected === u.territory ? setRow : undefined} className={`dip-unit-order${entry.selected === u.territory ? ' is-selected' : ''}`}>
      <button type="button" className="dip-unit" aria-pressed={entry.selected === u.territory}
        onClick={() => { entry.setSelected(current => current === u.territory ? null : u.territory); touched(); }}>{title(u.type)} · {territoryName(u.territory)}</button>
      <select aria-label={`Order for the ${u.type.toLowerCase()} in ${territoryName(u.territory)}`} disabled={disabled || !legalReady}
        value={legalReady ? entry.choices[u.id] ?? entry.defaultOrder(u) : ''} onChange={e => { entry.choose(u, e.target.value); touched(); }}>
        {!legalReady && <option value="">{loading}</option>}
        {menu(u.territory).map(([group, items]) => group ? <optgroup key={group} label={group}>{items.map(option)}</optgroup> : <Fragment key="hold">{items.map(option)}</Fragment>)}
      </select>
      {narrowed(u.territory) && <p className="dip-small dip-muted">Showing the orders that involve {placeName(entry.focus!)}. <button type="button" className="dip-link" onClick={() => entry.setFocus(null)}>Show all orders</button></p>}
      </div>)}

    {/* The unit picked on the map, its menu kept at the bottom of a narrow screen while its row is out of sight. */}
    {board.phase === 'ORDERS' && entry.selectedUnit && !rowShown && (() => { const u = entry.selectedUnit; return <div className="dip-quick-order" role="group" aria-label="Unit selected on the map">
      <strong>{title(u.type)} · {territoryName(u.territory)}</strong>
      <select aria-label="Order for the unit selected on the map" disabled={disabled || !legalReady}
        value={legalReady ? entry.choices[u.id] ?? entry.defaultOrder(u) : ''} onChange={e => { entry.choose(u, e.target.value); touched(); }}>
        {!legalReady && <option value="">{loading}</option>}
        {menu(u.territory).map(([group, items]) => group ? <optgroup key={group} label={group}>{items.map(option)}</optgroup> : <Fragment key="hold">{items.map(option)}</Fragment>)}
      </select>
      <span className="dip-small dip-muted">{narrowed(u.territory) ? <>Orders involving {placeName(entry.focus!)}. <button type="button" className="dip-link" onClick={() => entry.setFocus(null)}>Show all</button></>
        : 'Tap a highlighted place to move there, or another power’s unit or a place to list the orders that involve it.'}</span>
      <button type="button" className="dip-link" onClick={() => entry.setSelected(null)}>Done</button>
    </div>; })()}

    {board.phase === 'RETREATS' && entry.own.filter(u => u.mustRetreat).map(u => <label key={u.id}>Retreat from {territoryName(u.territory)}
      <select disabled={disabled} value={entry.retreats[u.id] ?? ''} onChange={e => { entry.setRetreats(v => ({ ...v, [u.id]: e.target.value })); touched(); }}>
        <option value="">Disband</option>
        {u.retreatOptions.flatMap(t => u.retreatCoasts[t]?.length ? u.retreatCoasts[t]!.map(c => `${t}/${c}`) : [t]).map(d => <option key={d} value={d}>Retreat to {placeName(d)}</option>)}
      </select></label>)}

    {board.phase === 'BUILDS' && <>
      <p className="dip-small">{entry.buildDelta > 0
        ? `You hold ${entry.buildDelta} more supply center${entry.buildDelta === 1 ? '' : 's'} than units, so you may build ${entry.buildDelta === 1 ? 'one unit' : `up to ${entry.buildDelta} units`} in your home centers (${built} chosen). Unused builds are waived.`
        : entry.buildDelta < 0 ? `You have ${mustDisband} more unit${mustDisband === 1 ? '' : 's'} than supply centers: choose ${mustDisband} to disband (${entry.disbands.length} chosen).`
        : 'Your units already match your supply centers.'}</p>
      {entry.buildDelta > 0 && entry.homes.length === 0 && <p className="dip-small dip-muted">None of your home centers is free to build in, so the builds are waived.</p>}
      {entry.buildDelta > 0 ? entry.homes.map(h => <label key={h.id}>Build in {h.name}
        <select disabled={disabled || (!entry.builds[h.id] && built >= entry.buildDelta)} value={entry.builds[h.id] ?? ''} onChange={e => { entry.setBuilds(v => ({ ...v, [h.id]: e.target.value })); touched(); }}>
          <option value="">No build</option><option value="ARMY">Army</option>
          {h.type !== 'LAND' && (h.coasts.length ? h.coasts.map(c => <option key={c} value={`FLEET/${c}`}>Fleet · {coastName(c)} coast</option>) : <option value="FLEET">Fleet</option>)}
        </select></label>)
        : entry.buildDelta < 0 && entry.own.map(u => <label key={u.id} className="dip-check">
          <input type="checkbox" disabled={disabled || (!entry.disbands.includes(u.id) && entry.disbands.length >= mustDisband)} checked={entry.disbands.includes(u.id)}
            onChange={e => { entry.setDisbands(v => e.target.checked ? [...v, u.id] : v.filter(id => id !== u.id)); touched(); }} />Disband the {u.type.toLowerCase()} in {territoryName(u.territory)}</label>)}
      {entry.buildDelta > 0 && built >= entry.buildDelta && entry.homes.length > built && <p className="dip-small dip-muted">That is all your builds; set one back to "No build" to build elsewhere instead.</p>}
    </>}

    {board.phase === 'ORDERS' && !disabled && entry.convoyHint && <p className="dip-small dip-muted">No convoys are possible this turn. A fleet can carry an army only from a coast that touches the sea the fleet is in (for example, an army in Yorkshire with a fleet in the North Sea), and the fleet must be ordered to convoy it.</p>}
    {!disabled && entry.convoyWarnings.map(w => <p className="dip-notice" role="status" key={w}>{w}</p>)}
  </div>;
}
