import type { PublicPhaseReport } from '@diplomacy/shared';

export function ReplayControls({
  report,
  frame,
  playing,
  speed,
  onFrameChange,
  onPlayingChange,
  onSpeedChange,
  onClose,
}: {
  report: PublicPhaseReport;
  frame: number;
  playing: boolean;
  speed: number;
  onFrameChange: (frame: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSpeedChange: (speed: number) => void;
  onClose: () => void;
}) {
  const labels = replayLabels(report);

  return (
    <div className="replay-controls" role="region" aria-label="Turn replay controls">
      <div>
        <strong>{report.year} {report.season} {report.phase}</strong>
        <span>{labels[frame]}</span>
      </div>
      <button
        type="button"
        onClick={() => onFrameChange(Math.max(0, frame - 1))}
        disabled={frame === 0}
        aria-label="Previous replay step"
      >
        Previous
      </button>
      <button type="button" onClick={() => onPlayingChange(!playing)}>
        {playing ? 'Pause' : frame === 2 ? 'Replay' : 'Play'}
      </button>
      <button
        type="button"
        onClick={() => onFrameChange(Math.min(2, frame + 1))}
        disabled={frame === 2}
        aria-label="Next replay step"
      >
        Next
      </button>
      <label>
        Speed
        <select
          value={speed}
          onChange={event => onSpeedChange(Number(event.target.value))}
        >
          <option value={0.5}>0.5x</option>
          <option value={1}>1x</option>
          <option value={2}>2x</option>
        </select>
      </label>
      <button type="button" onClick={onClose}>Skip / Close</button>
    </div>
  );
}

function replayLabels(report: PublicPhaseReport): [string, string, string] {
  if (report.phase === 'ORDERS') {
    return ['Positions before orders', 'Orders revealed', 'Resolved positions'];
  }
  if (report.phase === 'RETREATS') {
    return ['Dislodged positions', 'Retreat decisions', 'Resolved retreats'];
  }
  return ['Positions before adjustments', 'Adjustment decisions', 'Completed adjustments'];
}
