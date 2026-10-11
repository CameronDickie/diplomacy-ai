import type { PlaytestLog } from '@diplomacy/shared';
import { usd } from './text.js';

const ISSUES: Record<string, string> = {
  SELF_BLOCKED_MOVE: 'moved into its own unit that did not move out', SAME_DESTINATION: 'sent two units to the same territory',
  UNMATCHED_SUPPORT: 'supported an order it did not give', FOREIGN_SUPPORT: 'supported another power', UNMATCHED_CONVOY: 'convoy and army orders did not match',
};
function decisionText(decision: unknown): string {
  const d = decision as { orderIds?: unknown } | null;
  if (!d) return 'no usable answer';
  if (Array.isArray(d.orderIds)) return d.orderIds.length ? d.orderIds.join(', ') : 'no orders';
  const { phase: _phase, ...rest } = d as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** Development playtests only: which model decided each power, what it chose, how long it took and what it cost. */
export function DevLogView({ log, onExport }: { log: PlaytestLog; onExport: () => Promise<void> }) {
  const models = Object.entries(log.models);
  return <main id="dip-content">
    <div className="dip-heading"><p className="dip-meta">Development only</p><h1>Playtest <span>log</span></h1>
      <p>Built from the accounting records. Prompts and the models’ reasoning are not stored, so they are not here.</p>
      <button className="dip-solid" onClick={() => void onExport()}>Download the full game record</button></div>
    <section className="dip-section" aria-label="Totals by model"><h2>By model</h2>
      {models.length === 0 ? <p className="dip-muted">No model has been asked anything yet.</p> : <div className="dip-scroll"><table className="dip-log">
        <thead><tr><th>Model</th><th>Order calls</th><th>Valid</th><th>Self-defeating</th><th>Avg time</th><th>Orders cost</th><th>Replies</th><th>Replies cost</th></tr></thead>
        <tbody>{models.map(([model, t]) => <tr key={model}><td>{model}</td><td>{t.calls}</td><td>{t.valid}</td><td>{t.incoherent}</td>
          <td>{t.timedCalls ? `${(t.latencyMsTotal / t.timedCalls / 1000).toFixed(1)} s` : '—'}</td>
          <td>{usd(t.costNanousd)}{t.heldNanousd > 0 ? ` (+${usd(t.heldNanousd)} held)` : ''}</td><td>{t.chatCalls}</td><td>{usd(t.chatCostNanousd)}</td></tr>)}</tbody></table></div>}
    </section>
    {[...log.phases].reverse().map(phase => <section className="dip-section" key={phase.phaseId} aria-label={phase.phaseId}>
      <h2>{phase.phaseId.split(':').slice(-3, -1).join(' ')} · {phase.kind.toLowerCase()}</h2>
      <div className="dip-scroll"><table className="dip-log"><thead><tr><th>Power</th><th>Model</th><th>Outcome</th><th>Time</th><th>Cost</th><th>Chose</th></tr></thead>
        <tbody>{phase.calls.map((call, i) => <tr key={i} className={call.issues.length || call.outcome !== 'VALID' ? 'is-failed' : ''}>
          <td>{call.power}</td><td>{call.model}</td><td>{call.outcome ?? 'in flight'}</td><td>{call.latencyMs !== null ? `${(call.latencyMs / 1000).toFixed(1)} s` : '—'}</td><td>{call.costNanousd !== null ? usd(call.costNanousd) : '—'}</td>
          <td>{decisionText(call.decision)}{call.issues.length > 0 && <><br /><em>Self-defeating: {call.issues.map(issue => ISSUES[issue] ?? issue).join('; ')}</em></>}</td></tr>)}</tbody></table></div>
    </section>)}
  </main>;
}
