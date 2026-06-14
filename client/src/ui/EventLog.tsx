import type { LogEntry } from '../hooks/useGameSocket.js';

export function EventLog({ entries }: { entries: LogEntry[] }) {
  return (
    <section className="event-log">
      <h2>Event Log</h2>
      <div>
        {entries.map(entry => (
          <p className={entry.kind} key={entry.id}>
            <span>{entry.at}</span>
            <strong>{entry.event}</strong>
            <code>{entry.detail}</code>
          </p>
        ))}
      </div>
    </section>
  );
}
