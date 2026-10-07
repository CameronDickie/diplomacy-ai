import type { Power } from '@diplomacy/shared';
import type { PhaseRules } from '../attempts/PhaseRules.js';
import type { PhaseAction } from '../attempts/types.js';
import type { BoardFixture } from '../fixtures/BoardFixture.js';
import type { ScenarioFixture } from '../fixtures/ScenarioFixture.js';
import { buildChoices, retreatChoices } from '../luna/Choices.js';

/** The scripted human: the witness's orders for this turn where still legal, HOLD elsewhere; never dithers on retreats or builds. */
export async function scriptedHumanAction(rules: PhaseRules, board: BoardFixture, human: Power, fixture: ScenarioFixture, script: string): Promise<PhaseAction> {
  if (board.phase === 'RETREATS') { const set = retreatChoices(board,human); return set ? set.toAction(set.groups.map(g => g.choices.at(-1)!)) : { phase: 'RETREATS', retreats: {} }; }
  if (board.phase === 'BUILDS') { const set = buildChoices(board,human); return set ? set.toAction(set.defaultIndices) : { phase: 'BUILDS', builds: [], disbands: [] }; }
  const legal = await rules.legal(board,human,new AbortController().signal), step = fixture.witnesses.find(w => w.name === script)?.steps.find(s => s.phase === 'ORDERS' && s.year === board.year && s.season === board.season);
  const wanted = step && step.phase === 'ORDERS' ? step.orders : [];
  return { phase: 'ORDERS', orderIds: board.units.filter(u => u.power === human && !u.mustRetreat).map(u =>
    legal.find(o => o.unitTerritory === u.territory && wanted.includes(o.id))?.id ?? legal.find(o => o.unitTerritory === u.territory && o.order.type === 'HOLD')!.id) };
}

