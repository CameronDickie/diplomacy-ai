import { ALL_POWERS, type AutoplayGameFile, type Power } from '@diplomacy/shared';
import { reportRows } from '../challenge/History.js';
import { title } from '../challenge/text.js';
import { lineColor } from './CenterChart.js';
import { MODEL_NAMES, modelOf, type Turn } from './record.js';

export type Tab = 'orders' | 'messages' | 'calls';
const Badge = ({ game, power }: { game: AutoplayGameFile; power: Power }) =>
  <span className="viewer-power"><i style={{ background: lineColor(power) }} aria-hidden="true" />{title(power)} <small>{MODEL_NAMES[modelOf(game, power)]}</small></span>;
const nano = (n: number | null) => n === null ? '—' : `$${(n / 1e9).toFixed(4)}`;

/** One turn in words: what each power ordered and how it went, what they said to each other, and what each call cost. */
export function TurnPanel({ game, turn, tab, onTab }: { game: AutoplayGameFile; turn: Turn; tab: Tab; onTab: (tab: Tab) => void }) {
  const asks = turn.talk.filter(t => t.round === 'ASK').flatMap(t => t.messages.map(m => ({ from: t.power, to: m.to, body: m.body })));
  const replies = turn.talk.filter(t => t.round === 'REPLY').flatMap(t => t.messages.map(m => ({ from: t.power, to: m.to, body: m.body })));
  const rows = reportRows(turn.report);
  const powers = ALL_POWERS.filter(p => rows.some(r => r.power === p));
  return <aside className="viewer-panel" aria-label="This turn">
    <div className="viewer-tabs" role="tablist">
      {([['orders', 'Orders'], ['messages', `Messages${asks.length ? ` · ${asks.length + replies.length}` : ''}`], ['calls', `Calls${turn.failures.length ? ` · ${turn.failures.length} failed` : ''}`]] as const).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}>{label}</button>)}
    </div>
    {tab === 'orders' && (powers.length === 0 ? <p className="dip-muted">Nothing changed in this step.</p> : powers.map(p =>
      <section key={p} className="viewer-block"><Badge game={game} power={p} />
        {turn.notes.filter(n => n.power === p).map((n, i) => <p key={i} className="viewer-note"><span className="dip-muted">Private note:</span> {n.note}</p>)}
        <ul>{rows.filter(r => r.power === p).map((r, i) => <li key={i} className={r.failed ? 'is-failed' : ''}>{r.text}<small>{r.result}</small></li>)}</ul></section>))}
    {tab === 'messages' && (asks.length === 0 ? <p className="dip-muted">{turn.report.phase === 'ORDERS' ? 'Nobody wrote to anyone this turn.' : 'Powers write to each other only before orders.'}</p>
      : asks.map((ask, i) => {
        const reply = replies.find(r => r.from === ask.to && r.to === ask.from);
        return <section key={i} className="viewer-block viewer-thread">
          <p><Badge game={game} power={ask.from} /> <span className="dip-muted">to</span> {title(ask.to)}</p><blockquote>{ask.body}</blockquote>
          {reply ? <><p><Badge game={game} power={reply.from} /> <span className="dip-muted">replied</span></p><blockquote>{reply.body}</blockquote></>
            : <p className="dip-muted dip-small">No reply.</p>}
        </section>;
      }))}
    {tab === 'calls' && <>
      {turn.failures.length > 0 && <section className="viewer-block"><h3>Failed or retried</h3>
        <ul>{turn.failures.map((f, i) => <li key={i} className="is-failed">{f.reason}</li>)}</ul></section>}
      <div className="dip-scroll"><table className="dip-log">
        <thead><tr><th scope="col">Power</th><th scope="col">Call</th><th scope="col">Outcome</th><th scope="col">Tokens in / out</th><th scope="col">Seconds</th><th scope="col">Cost</th></tr></thead>
        <tbody>{[...turn.talk.map(c => ({ ...c, kind: c.round === 'ASK' ? 'Message' : 'Reply' })), ...turn.calls.map(c => ({ ...c, kind: 'Decision' }))].map((c, i) =>
          <tr key={i} className={c.outcome !== 'VALID' ? 'is-failed' : ''}><td>{title(c.power)}</td><td>{c.kind}</td><td>{c.outcome ?? 'unknown'}</td>
            <td>{c.inputTokens ?? '—'} / {c.outputTokens ?? '—'}</td><td>{c.latencyMs === null ? '—' : (c.latencyMs / 1000).toFixed(1)}</td><td>{nano(c.costNanousd)}</td></tr>)}</tbody>
      </table></div>
    </>}
  </aside>;
}
