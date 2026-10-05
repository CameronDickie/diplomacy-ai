import { ALL_POWERS } from '@diplomacy/shared';
import { fixtureSchema as s } from '../fixtures/BoardFixture.js';
import type { PhaseAction, PhaseDecisions } from './types.js';

const text = (v: unknown, path: string) => {
  if (typeof v !== 'string' || !v.length || v.length > 160) return s.fail(path, 'invalid choice ID');
  return v;
};
/** Strict transport/storage boundary. Legality is separately checked against the frozen board. */
export function parseAction(input: unknown): PhaseAction {
  const phase = s.member(s.object(input, 'action').phase, ['ORDERS', 'RETREATS', 'BUILDS'] as const, 'action.phase');
  const value = s.fields(input, ['phase', ...(phase === 'ORDERS' ? ['orderIds'] : phase === 'RETREATS' ? ['retreats'] : ['builds', 'disbands'])], 'action');
  if (phase === 'ORDERS') {
    const orderIds = s.array(value.orderIds, 'action.orderIds', 150).map(v => text(v, 'action.orderIds')).sort();
    s.unique(orderIds, 'action.orderIds');
    return { phase, orderIds };
  }
  if (phase === 'RETREATS') {
    const entries = Object.entries(s.object(value.retreats, 'action.retreats'));
    if (entries.length > 150) s.fail('action.retreats', 'too many choices');
    return { phase, retreats: Object.fromEntries(entries.map(([id, raw]) => {
      text(id, 'action.retreats.id');
      if (raw === null) return [id, null];
      const d = s.fields(raw, ['territory', 'coast'], 'action.retreats.destination');
      return [id, { territory: s.province(d.territory, 'action.retreats.territory'), coast: s.coast(d.coast, 'action.retreats.coast') }];
    })) };
  }
  const builds = s.array(value.builds, 'action.builds', 34).map(raw => {
    const b = s.fields(raw, ['type', 'territory', 'coast'], 'action.build');
    return { type: s.member(b.type, ['ARMY', 'FLEET'] as const, 'action.build.type'), territory: s.province(b.territory, 'action.build.territory'), coast: s.coast(b.coast, 'action.build.coast') };
  }).sort((a,b) => a.territory.localeCompare(b.territory));
  const disbands = s.array(value.disbands, 'action.disbands', 150).map(v => text(v, 'action.disbands')).sort();
  s.unique(disbands, 'action.disbands');
  s.unique(builds.map(b => b.territory), 'action.builds');
  return { phase, builds, disbands };
}
export function parseDecisions(input: unknown): PhaseDecisions {
  return Object.fromEntries(Object.entries(s.object(input, 'decisions')).map(([power, action]) =>
    [s.member(power, ALL_POWERS, 'decisions.power'), parseAction(action)]));
}
