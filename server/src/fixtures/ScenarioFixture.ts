import { ALL_POWERS, gamePhaseId, TERRITORY_MAP } from '@diplomacy/shared';
import type { Phase, Power, RetreatDestination, Season, SubmitBuildsPayload } from '@diplomacy/shared';
import { GameRoom } from '../GameRoom.js';
import { scoreChallenge, type ChallengeDefinition, type ChallengeScore } from '../challenge/TunisPilot.js';
import { boardHash, exportBoard, fixtureSchema as s, importBoard, type BoardFixture } from './BoardFixture.js';

type StepBase = { year: number; season: Season; phase: Phase };
export type WitnessStep = StepBase & (
  { phase: 'ORDERS'; orders: string[] } |
  { phase: 'RETREATS'; retreats: Record<string, RetreatDestination | null> } |
  { phase: 'BUILDS'; adjustments: Partial<Record<Power, Omit<SubmitBuildsPayload, 'gameId'>>> }
);
export interface ScenarioFixture {
  schemaVersion: 1;
  id: string;
  version: number;
  title: string;
  provenance: 'AI_GENERATED_DEVELOPMENT';
  board: BoardFixture;
  objective: { humanPower: Power; territory: string; deadlineYear: number; earlyAchievementYear: number } | null;
  witnesses: Array<{ name: string; steps: WitnessStep[]; expectedOutcome: ChallengeScore['outcome'] | null }>;
}
function text(value: unknown, path: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) s.fail(path, `expected nonempty text up to ${max} characters`);
  return value as string;
}
function year(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 9999) s.fail(path, 'expected integer 1–9999');
  return value as number;
}
function parseStep(input: unknown, path: string): WitnessStep {
  const phase = s.member(s.object(input, path).phase, ['ORDERS', 'RETREATS', 'BUILDS'] as const, `${path}.phase`);
  const value = s.fields(input, ['year', 'season', 'phase', phase === 'ORDERS' ? 'orders' : phase === 'RETREATS' ? 'retreats' : 'adjustments'], path);
  const base = { year: year(value.year, `${path}.year`), season: s.member(value.season, ['SPRING', 'FALL', 'WINTER'] as const, `${path}.season`) };
  if ((phase === 'BUILDS') !== (base.season === 'WINTER')) s.fail(path, 'inconsistent phase/season');
  if (phase === 'ORDERS') {
    const orders = s.array(value.orders, `${path}.orders`, 75).map((id, i) => text(id, `${path}.orders[${i}]`));
    s.unique(orders, `${path}.orders`);
    return { ...base, phase, orders };
  }
  if (phase === 'RETREATS') {
    const retreats = Object.fromEntries(Object.entries(s.object(value.retreats, `${path}.retreats`)).map(([id, destination]) => {
      text(id, `${path}.retreats.id`, 100);
      if (destination === null) return [id, null];
      const d = s.fields(destination, ['territory', 'coast'], `${path}.retreats.${id}`);
      return [id, { territory: s.province(d.territory, `${path}.retreats.${id}.territory`), coast: s.coast(d.coast, `${path}.retreats.${id}.coast`) }];
    }));
    return { ...base, phase, retreats };
  }
  const adjustments = Object.fromEntries(Object.entries(s.object(value.adjustments, `${path}.adjustments`)).map(([power, input]) => {
    s.member(power, ALL_POWERS, `${path}.adjustments`);
    const a = s.fields(input, ['builds', 'disbands'], `${path}.adjustments.${power}`);
    const builds = s.array(a.builds, `${path}.builds`, 34).map(input => {
      const b = s.fields(input, ['type', 'territory', 'coast'], `${path}.builds`);
      return { type: s.member(b.type, ['ARMY', 'FLEET'] as const, `${path}.builds.type`), territory: s.province(b.territory, `${path}.builds.territory`), coast: s.coast(b.coast, `${path}.builds.coast`) };
    });
    const disbands = s.array(a.disbands, `${path}.disbands`, 75).map(id => text(id, `${path}.disbands`, 100));
    return [power, { builds, disbands }];
  }));
  return { ...base, phase, adjustments };
}

export async function importScenario(input: unknown): Promise<ScenarioFixture> {
  const v = s.fields(input, ['schemaVersion', 'id', 'version', 'title', 'provenance', 'board', 'objective', 'witnesses'], 'scenario');
  if (v.schemaVersion !== 1) s.fail('scenario.schemaVersion', 'only version 1 is supported');
  const id = text(v.id, 'scenario.id', 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) s.fail('scenario.id', 'expected a lowercase slug');
  const version = year(v.version, 'scenario.version');
  if (v.provenance !== 'AI_GENERATED_DEVELOPMENT') s.fail('scenario.provenance', 'development fixtures must be labeled AI_GENERATED_DEVELOPMENT');
  let objective: ScenarioFixture['objective'] = null;
  if (v.objective !== null) {
    const o = s.fields(v.objective, ['humanPower', 'territory', 'deadlineYear', 'earlyAchievementYear'], 'scenario.objective');
    const territory = s.province(o.territory, 'scenario.objective.territory');
    if (!TERRITORY_MAP[territory].isSupplyCenter) s.fail('scenario.objective.territory', 'objective requires a supply center');
    objective = { humanPower: s.member(o.humanPower, ALL_POWERS, 'scenario.objective.humanPower'), territory, deadlineYear: year(o.deadlineYear, 'scenario.objective.deadlineYear'), earlyAchievementYear: year(o.earlyAchievementYear, 'scenario.objective.earlyAchievementYear') };
    if (objective.earlyAchievementYear > objective.deadlineYear) s.fail('scenario.objective', 'achievement cannot follow the deadline');
  }
  const witnesses = s.array(v.witnesses, 'scenario.witnesses', 20).map((input, i) => {
    const path = `scenario.witnesses[${i}]`;
    const w = s.fields(input, ['name', 'steps', 'expectedOutcome'], path);
    const expectedOutcome = w.expectedOutcome === null ? null : s.member(w.expectedOutcome, ['INCOMPLETE', 'SUCCESS', 'FAILURE', 'ABANDONED'] as const, `${path}.expectedOutcome`);
    if (expectedOutcome !== null && objective === null) s.fail(path, 'a scored witness needs an objective');
    return { name: text(w.name, `${path}.name`), steps: s.array(w.steps, `${path}.steps`, 100).map((step,j) => parseStep(step, `${path}.steps[${j}]`)), expectedOutcome };
  });
  s.unique(witnesses.map(w => w.name), 'scenario.witnesses.name');
  const board = await importBoard(v.board);
  if (objective && objective.deadlineYear < board.year) s.fail('scenario.objective.deadlineYear', 'deadline precedes the initial board');
  return { schemaVersion: 1, id, version, title: text(v.title, 'scenario.title'), provenance: 'AI_GENERATED_DEVELOPMENT', board, objective, witnesses };
}

export function challengeDefinition(fixture: ScenarioFixture): ChallengeDefinition | null {
  const o = fixture.objective;
  if (!o) return null;
  return { id: fixture.id, version: fixture.version, title: fixture.title,
    objectiveText: `As ${o.humanPower}, own ${o.territory} after Fall ${o.deadlineYear} or sooner.`,
    variant: 'CLASSICAL', rulesEngine: 'godip@v0.6.5', startingPosition: { fixtureId: fixture.id, version: fixture.version },
    humanPower: o.humanPower, opponentPowers: ALL_POWERS.filter(p => p !== o.humanPower),
    opponentPolicy: 'SPONSORED_LUNA_UNRANKED', objective: { kind: 'OWN_SUPPLY_CENTER_AFTER_FALL', territory: o.territory, deadlineYear: o.deadlineYear },
    earlyAchievementYear: o.earlyAchievementYear, rotation: 'PILOT_ONLY', tiePolicy: 'NOT_POSSIBLE_SINGLE_OWNER' };
}

/** In-memory human seats only: no .env loading, provider, DB, HTTP or socket IO. */
export async function playWitness(fixture: ScenarioFixture, name: string, includeReports = false) {
  const witness = fixture.witnesses.find(w => w.name === name);
  if (!witness) s.fail('witness', 'unknown witness name');
  const room = await GameRoom.fromBoardFixture(fixture.board);
  try {
    for (const power of ALL_POWERS) room.addPlayer(`fixture-${power}`, power, power);
    await room.startGame();
    for (const [index, step] of witness!.steps.entries()) {
      const state = room.getState(), phaseId = gamePhaseId(state);
      const path = `witness.steps[${index}]`;
      if (state.year !== step.year || state.season !== step.season || state.phase !== step.phase) s.fail(path, 'step does not match current phase');
      if (step.phase === 'ORDERS') {
        const catalogs = (await Promise.all(ALL_POWERS.map(p => room.getLegalOrders(p)))).flat();
        const catalog = new Map(catalogs.map(o => [o.id, o.order]));
        const orders = step.orders.map(id => catalog.get(id) ?? s.fail(path, `unknown/illegal order ID ${id}`));
        s.unique(orders.map(o => o.unitTerritory), path);
        // Unlisted units HOLD, and even those defaults must come from Godip.
        for (const unit of state.units) if (!orders.some(o => o.unitTerritory === unit.territory)) {
          const hold = catalogs.find(o => o.order.unitTerritory === unit.territory && o.order.type === 'HOLD');
          if (!hold) s.fail(path, `no legal HOLD for ${unit.territory}`);
          orders.push(hold!.order);
        }
        const powers = ALL_POWERS.filter(p => state.units.some(u => u.power === p));
        for (const power of powers) {
          const result = await room.submitCommand(power, { phase: 'ORDERS', phaseId, requestId: `witness-${index}-${power}`, orders: orders.filter(o => o.power === power) });
          if (result.status !== 'ACCEPTED') s.fail(path, result.error?.message ?? result.status);
        }
      } else if (step.phase === 'RETREATS') {
        const units = state.units.filter(u => u.mustRetreat);
        for (const id of Object.keys(step.retreats)) if (!units.some(u => u.id === id)) s.fail(path, `unknown retreating unit ${id}`);
        for (const power of ALL_POWERS.filter(p => units.some(u => u.power === p))) {
          const retreats = Object.fromEntries(units.filter(u => u.power === power).map(u => [u.id, step.retreats[u.id] ?? null]));
          const result = await room.submitCommand(power, { phase: 'RETREATS', phaseId, requestId: `witness-${index}-${power}`, retreats });
          if (result.status !== 'ACCEPTED') s.fail(path, result.error?.message ?? result.status);
        }
      } else {
        const powers = ALL_POWERS.filter(p => Object.values(state.territories).filter(t => t.isSupplyCenter && t.owner === p).length !== state.units.filter(u => u.power === p).length);
        for (const power of Object.keys(step.adjustments) as Power[]) if (!powers.includes(power)) s.fail(path, `no adjustment needed for ${power}`);
        for (const power of powers.length ? powers : ['AUSTRIA'] as Power[]) {
          const adjustment = step.adjustments[power] ?? { builds: [], disbands: [] };
          const result = await room.submitCommand(power, { phase: 'BUILDS', phaseId, requestId: `witness-${index}-${power}`, ...adjustment });
          if (result.status !== 'ACCEPTED') s.fail(path, result.error?.message ?? result.status);
        }
      }
      await importBoard(exportBoard(room.getState()));
    }
    const definition = challengeDefinition(fixture);
    const score = definition ? scoreChallenge(definition, { challengeId: fixture.id, challengeVersion: fixture.version, lifecycle: room.getState().status === 'FINISHED' ? 'GAME_FINISHED' : 'ACTIVE', reports: room.getPhaseHistory() }) : null;
    if (witness!.expectedOutcome !== null && score?.outcome !== witness!.expectedOutcome) s.fail('witness.expectedOutcome', `expected ${witness!.expectedOutcome}, got ${score?.outcome}`);
    const board = exportBoard(room.getState());
    return { fixtureId: fixture.id, fixtureVersion: fixture.version, witness: name, board, boardHash: boardHash(board), score, ...(includeReports ? {reports: room.getPhaseHistory()} : {}) };
  } finally { room.dispose(); }
}
