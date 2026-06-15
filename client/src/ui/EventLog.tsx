import type { LogEntry } from '../hooks/useGameSocket.js';

export function EventLog({
  entries,
  open,
  onToggle,
}: {
  entries: LogEntry[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section className={`event-log ${open ? '' : 'collapsed'}`}>
      <header>
        {open && <h2>Event Log</h2>}
        <button
          type="button"
          aria-label={open ? 'Minimize event log' : 'Open event log'}
          onClick={onToggle}
        >
          {open ? 'Minimize' : 'Logs'}
        </button>
      </header>
      {open && (
        <div className="event-log-entries">
          {entries.map(entry => (
            <p className={entry.kind} key={entry.id}>
              <span>{entry.at}</span>
              <strong>{entry.event}</strong>
              <code>{entry.detail}</code>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
