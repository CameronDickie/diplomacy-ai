import { territoryName } from '../lib/game.js';

export const title = (word: string) => word[0] + word.slice(1).toLowerCase();
const place = (t?: string) => t ? territoryName(t.split('/')[0] as Parameters<typeof territoryName>[0]) + (t.includes('/') ? ` (${t.split('/')[1].toLowerCase()} coast)` : '') : '';

/** An order ID as a sentence: "LVP|MOVE|YOR" reads "Liverpool moves to Yorkshire". */
export function describeOrder(id: string): string {
  const [unit, type, first, second] = id.split('|');
  return type === 'HOLD' ? `${place(unit)} holds` : type === 'MOVE' ? `${place(unit)} moves to ${place(first)}` : type === 'MOVE_VIA_CONVOY' ? `${place(unit)} moves to ${place(first)} by convoy`
    : type === 'SUPPORT_HOLD' ? `${place(unit)} supports ${place(first)} holding` : type === 'SUPPORT_MOVE' ? `${place(unit)} supports ${place(first)} to ${place(second)}`
    : type === 'CONVOY' ? `${place(unit)} convoys ${place(first)} to ${place(second)}` : id.split('|').join(' · ');
}
export function phaseTitle(board: { year: number; season: string; phase: string }): string {
  return board.phase === 'ORDERS' ? `${title(board.season)} ${board.year} · orders` : board.phase === 'RETREATS' ? `${title(board.season)} ${board.year} · retreats` : `Winter ${board.year} · builds and disbands`;
}
export function untilChange(at: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((at - now) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
export const usd = (nanousd: number) => `$${(nanousd / 1e9).toFixed(5)}`;
