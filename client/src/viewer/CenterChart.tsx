import { useMemo, useRef, type PointerEvent } from 'react';
import { ALL_POWERS, type AutoplayGameFile, type Power } from '@diplomacy/shared';
import { POWER_COLORS } from '../lib/game.js';
import { title } from '../challenge/text.js';
import { MODEL_NAMES, dashed, eliminations, modelOf, type Turn } from './record.js';

const W = 1000, H = 280, PAD = { left: 34, right: 12, top: 12, bottom: 28 }, TOP = 18;
/** Russia's white is invisible on the light page; the chart uses a variable that each theme sets. */
export const lineColor = (power: Power) => power === 'RUSSIA' ? 'var(--viewer-russia)' : POWER_COLORS[power];

/**
 * Supply centers per power after every phase, one line each: solid for OpenAI's models, dashed for
 * Anthropic's. Clicking or dragging across it moves the board to that turn.
 */
export function CenterChart({ game, turns, index, onSelect }: { game: AutoplayGameFile; turns: Turn[]; index: number; onSelect: (index: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  // A power's line ends where it lost its last center, so the zero line stays readable.
  const out = useMemo(() => eliminations(turns), [turns]);
  const x = (i: number) => PAD.left + (turns.length > 1 ? i / (turns.length - 1) : 0) * (W - PAD.left - PAD.right);
  const y = (n: number) => PAD.top + (1 - n / TOP) * (H - PAD.top - PAD.bottom);
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = ref.current!.getBoundingClientRect(), at = ((event.clientX - box.left) / box.width) * W;
    onSelect(Math.max(0, Math.min(turns.length - 1, Math.round(((at - PAD.left) / (W - PAD.left - PAD.right)) * (turns.length - 1)))));
  };
  // A tick at the first phase of each decade, and of the first year.
  const ticks = turns.filter((t, i) => i === 0 || (t.report.year % 10 === 0 && turns[i - 1].report.year !== t.report.year));
  const current = turns[index];
  const leader = current ? Math.max(...ALL_POWERS.map(p => current.centers[p])) : 0;
  return <figure className="viewer-chart">
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="none"
      aria-label={`Supply centers per power over ${turns.length} phases. ${current ? `At ${title(current.report.season)} ${current.report.year}: ${ALL_POWERS.map(p => `${title(p)} ${current.centers[p]}`).join(', ')}.` : ''}`}
      onPointerDown={event => { ref.current!.setPointerCapture(event.pointerId); pick(event); }}
      onPointerMove={event => { if (event.buttons) pick(event); }}>
      {[0, 6, 12].map(n => <g key={n}><line x1={PAD.left} x2={W - PAD.right} y1={y(n)} y2={y(n)} className="viewer-grid" />
        <text x={PAD.left - 8} y={y(n) + 4} textAnchor="end" className="viewer-axis">{n}</text></g>)}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(18)} y2={y(18)} className="viewer-win" />
      <text x={PAD.left - 8} y={y(18) + 4} textAnchor="end" className="viewer-axis">18</text>
      <text x={W - PAD.right} y={y(18) - 5} textAnchor="end" className="viewer-axis">solo win</text>
      {ticks.map(t => <text key={t.index} x={x(t.index)} y={H - 8} textAnchor="middle" className="viewer-axis">{t.report.year}</text>)}
      {ALL_POWERS.map(p => <polyline key={p} fill="none" stroke={lineColor(p)} strokeWidth={2.2} vectorEffect="non-scaling-stroke"
        strokeDasharray={dashed(modelOf(game, p)) ? '6 4' : undefined} strokeLinejoin="round"
        points={turns.slice(0, (out[p] ?? turns.length - 1) + 1).map(t => `${x(t.index).toFixed(1)},${y(t.centers[p]).toFixed(1)}`).join(' ')} />)}
      {ALL_POWERS.filter(p => out[p] !== undefined).map(p => <text key={p} x={x(out[p]!)} y={y(0) - 6} textAnchor="middle" className="viewer-out-mark" fill={lineColor(p)}>×</text>)}
      {current && <line x1={x(index)} x2={x(index)} y1={PAD.top} y2={H - PAD.bottom} className="viewer-cursor" />}
    </svg>
    <figcaption className="viewer-legend">
      {ALL_POWERS.map(p => <span key={p} className={current && current.centers[p] === leader && leader > 0 ? 'is-leading' : ''}>
        <svg width="26" height="10" aria-hidden="true"><line x1="1" x2="25" y1="5" y2="5" stroke={lineColor(p)} strokeWidth="2.5" strokeDasharray={dashed(modelOf(game, p)) ? '6 4' : undefined} /></svg>
        {title(p)} <small>{MODEL_NAMES[modelOf(game, p)]}</small> <strong>{current?.centers[p] ?? ''}</strong></span>)}
    </figcaption>
  </figure>;
}
