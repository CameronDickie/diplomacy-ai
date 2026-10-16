import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_POWERS, TERRITORIES, type Power } from '@diplomacy/shared';
import { PhaseRules } from '../attempts/PhaseRules.js';
import { fullGameDefinition } from '../autoplay/Autoplay.js';
import { forcedAction } from '../luna/Choices.js';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';
import type { BoardFixture } from '../fixtures/BoardFixture.js';

test.after(() => shutdownGodip());

/**
 * Game 11 (all GPT-6 Luna): Austria stood on its eighteenth center at the end of Fall 1941 while a French
 * fleet it had dislodged retreated. The win was counted after the retreat, and the game was left in a
 * retreats phase with nobody retreating, which no board may be: every recovery failed the same way.
 */
test('a solo win counted after Fall retreats ends the game with a valid board',async () => {
  const centers = TERRITORIES.filter(t => t.isSupplyCenter).map(t => t.id).sort();
  const austria = centers.filter(t => t !== 'ROM').slice(0,17);
  const owners = Object.fromEntries(TERRITORIES.map(t => [t.id, austria.includes(t.id) ? 'AUSTRIA' : t.id === 'ROM' ? 'FRANCE' : null])) as Record<string, Power | null>;
  const unit = (id: string, power: Power, type: 'ARMY' | 'FLEET', territory: string, extra = {}) => ({ id, power, type, territory, coast: null, mustRetreat: false, retreatOptions: [], retreatCoasts: {}, dislodgedBy: null, ...extra });
  const board = { schemaVersion: 1, variant: 'CLASSICAL', rulesEngine: 'godip@v0.6.5', powers: [...ALL_POWERS], year: 1941, season: 'FALL', phase: 'RETREATS',
    territoryOwners: owners, retreatContext: { dislodgers: { TUS: 'ROM' }, bounces: {} },
    units: [unit('a-rom','AUSTRIA','ARMY','ROM'),unit('f-rom','FRANCE','FLEET','ROM',{ mustRetreat: true, retreatOptions: ['NAP','TYS'], dislodgedBy: 'TUS' })] } as unknown as BoardFixture;
  const definition = fullGameDefinition(1950), placeholder = forcedAction(board);
  const decisions = Object.fromEntries(ALL_POWERS.map(p => [p, p === 'FRANCE' ? { phase: 'RETREATS', retreats: { 'f-rom': { territory: 'TYS', coast: null } } } : placeholder]));
  const job = { operationId: 'op-solo', attemptId: 'auto-solo', phaseId: 'auto-solo:1941:FALL:RETREATS', revision: 1, reportOffset: 0, createdAt: 1_800_000_000_000,
    board, definition, humanAction: placeholder, decisions } as never;
  const result = await new PhaseRules().resolve(job,new AbortController().signal);
  assert.equal(result.finished,true);
  assert.equal(result.board.phase,'ORDERS'); assert.equal(result.board.season,'FALL');
  assert.equal(TERRITORIES.filter(t => t.isSupplyCenter && result.board.territoryOwners[t.id] === 'AUSTRIA').length,18);
  assert.equal(result.reports[0].phase,'RETREATS');
});
