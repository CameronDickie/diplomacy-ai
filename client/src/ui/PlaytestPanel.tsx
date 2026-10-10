import type { PlaytestLog } from '@diplomacy/shared';

const usd = (nanousd: number) => `$${(nanousd / 1e9).toFixed(5)}`;
/** A decision as short text: order IDs are already readable ("LON|MOVE|NTH"); anything else is shown as stored. */
function decisionText(decision: unknown): string {
  const d = decision as { orderIds?: unknown } | null;
  if (!d) return 'no usable answer';
  if (Array.isArray(d.orderIds)) return d.orderIds.length ? d.orderIds.join(', ') : 'no orders';
  const { phase: _phase, ...rest } = d as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** Development playtests only: which model decided each power, what it chose, how long it took and what it cost. */
export function PlaytestPanel({ log }: { log: PlaytestLog }) {
  const models = Object.entries(log.models);
  if (!models.length) return null;
  return <section className="challenge-playtest" aria-label="Playtest log">
    <h2>Playtest log</h2>
    <p className="muted">Development only. Built from the accounting records; prompts and raw answers are not stored.</p>
    <table><thead><tr><th>Model</th><th>Calls</th><th>Valid</th><th>Avg time</th><th>Cost</th></tr></thead>
      <tbody>{models.map(([model, t]) => <tr key={model}>
        <td>{model}</td><td>{t.calls}</td><td>{t.valid}</td>
        <td>{t.timedCalls ? `${(t.latencyMsTotal / t.timedCalls / 1000).toFixed(1)} s` : '—'}</td>
        <td>{usd(t.costNanousd)}{t.heldNanousd > 0 ? ` (+${usd(t.heldNanousd)} held)` : ''}</td>
      </tr>)}</tbody></table>
    {[...log.phases].reverse().map((phase, index) => <details key={phase.phaseId} open={index === 0}>
      <summary>{phase.phaseId.split(':').slice(-3, -1).join(' ')} · {phase.kind.toLowerCase()}</summary>
      <ul>{phase.calls.map((call, i) => <li key={i}>
        <strong>{call.power}</strong> · {call.model} · {call.outcome ?? 'in flight'}
        {call.latencyMs !== null ? ` · ${(call.latencyMs / 1000).toFixed(1)} s` : ''}
        {call.costNanousd !== null ? ` · ${usd(call.costNanousd)}` : ''}
        <br/><span className="muted">{decisionText(call.decision)}</span>
      </li>)}</ul>
    </details>)}
  </section>;
}
