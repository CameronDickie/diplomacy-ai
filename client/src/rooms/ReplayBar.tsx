import type { PublicPhaseReport } from '@diplomacy/shared';
import { phaseTitle } from '../challenge/text.js';

const STEPS: Record<PublicPhaseReport['phase'], [string, string, string]> = {
  ORDERS: ['Positions before orders', 'Orders revealed', 'Resolved positions'],
  RETREATS: ['Dislodged positions', 'Retreat decisions', 'Resolved retreats'],
  BUILDS: ['Positions before adjustments', 'Adjustment decisions', 'Completed adjustments'],
};

/** Steps one resolved phase through before, orders and result on the map. */
export function ReplayBar({ report, frame, playing, speed, onFrameChange, onPlayingChange, onSpeedChange, onClose }: {
  report: PublicPhaseReport; frame: number; playing: boolean; speed: number;
  onFrameChange: (frame: number) => void; onPlayingChange: (playing: boolean) => void; onSpeedChange: (speed: number) => void; onClose: () => void;
}) {
  return <div className="dip-replay" role="region" aria-label="Replay controls">
    <strong>{phaseTitle(report)} · {STEPS[report.phase][frame]}</strong>
    <button type="button" onClick={() => onFrameChange(Math.max(0, frame - 1))} disabled={frame === 0}>Previous</button>
    <button type="button" onClick={() => onPlayingChange(!playing)}>{playing ? 'Pause' : frame === 2 ? 'Play again' : 'Play'}</button>
    <button type="button" onClick={() => onFrameChange(Math.min(2, frame + 1))} disabled={frame === 2}>Next</button>
    <select aria-label="Replay speed" style={{ width: 'auto' }} value={speed} onChange={event => onSpeedChange(Number(event.target.value))}>
      <option value={0.5}>Half speed</option><option value={1}>Normal speed</option><option value={2}>Double speed</option>
    </select>
    <button type="button" className="dip-solid" onClick={onClose}>Return to the orders log</button>
  </div>;
}
