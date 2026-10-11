import type { Power, PublicPhaseReport } from '@diplomacy/shared';
import { territoryName } from '../lib/game.js';
import { describeOrder, title } from './text.js';

const place = (t: string) => territoryName(t.split('/')[0] as Parameters<typeof territoryName>[0]);
const when = (r: PublicPhaseReport) => r.phase === 'ORDERS' ? `${title(r.season)} ${r.year}` : r.phase === 'RETREATS' ? `${title(r.season)} ${r.year} · retreats` : `Winter ${r.year} · builds and disbands`;

/** What one phase recorded, as rows of power, what it did, and how that turned out. */
function rows(report: PublicPhaseReport): Array<{ power: Power; text: string; result: string; failed: boolean }> {
  if (report.phase === 'ORDERS') return report.resolvedOrders.map(o => ({ power: o.power, text: describeOrder(o.id), result: o.resolution === 'SUCCEEDS' ? 'Succeeded' : title(o.resolution), failed: o.resolution !== 'SUCCEEDS' }));
  if (report.phase === 'RETREATS') return report.retreats.map(r => ({ power: r.power, text: `${place(r.fromTerritory)} ${r.toTerritory ? `retreats to ${place(r.toTerritory)}` : 'has nowhere to go'}`, result: title(r.outcome), failed: r.outcome !== 'RETREATED' }));
  return report.adjustments.flatMap(a => [...a.builds.map(b => ({ power: a.power, text: `Builds ${b.type === 'ARMY' ? 'an army' : 'a fleet'} in ${place(b.territory)}`, result: 'Built', failed: false })),
    ...a.disbandedUnits.map(u => ({ power: a.power, text: `Disbands ${u.type === 'ARMY' ? 'the army' : 'the fleet'} in ${place(u.territory)}`, result: 'Disbanded', failed: false })),
    ...(a.waivedBuilds ? [{ power: a.power, text: `Waives ${a.waivedBuilds} build${a.waivedBuilds === 1 ? '' : 's'}`, result: 'Waived', failed: false }] : [])]);
}

/** The orders log: every phase of this game, newest first, with every power's orders and results. */
export function HistoryView({ reports, human, onShow }: { reports: PublicPhaseReport[]; human: Power; onShow: (index: number) => void }) {
  return <main id="dip-content">
    <div className="dip-heading"><p className="dip-meta">History</p><h1>The <span>orders log</span></h1>
      <p>Every turn of this game so far: what each power ordered and whether it worked. Your own orders are marked. Only you can see your game.</p></div>
    {reports.length === 0 && <p className="dip-muted">Nothing has been resolved yet. Submit your first orders and the turn will appear here.</p>}
    {reports.map((report, index) => ({ report, index })).reverse().map(({ report, index }) => {
      const list = rows(report).sort((a, b) => Number(b.power === human) - Number(a.power === human) || a.power.localeCompare(b.power));
      return <section className="dip-section" key={report.id} aria-label={when(report)}>
        <div className="dip-phase-head"><h2>{when(report)}</h2><button className="dip-link" onClick={() => onShow(index)}>Show {when(report)} on the map</button></div>
        {list.length === 0 ? <p className="dip-muted">Nothing changed in this step.</p> : <div className="dip-scroll"><table className="dip-log">
          <thead><tr><th scope="col">Power</th><th scope="col">Order</th><th scope="col">Result</th></tr></thead>
          <tbody>{list.map((row, i) => <tr key={i} className={`${row.power === human ? 'is-own' : ''} ${row.failed ? 'is-failed' : ''}`.trim()}>
            <td>{title(row.power)}{row.power === human ? ' (you)' : ''}</td><td>{row.text}</td><td>{row.result}</td></tr>)}</tbody></table></div>}
      </section>;
    })}
  </main>;
}
