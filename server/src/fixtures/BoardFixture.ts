import { createHash } from 'node:crypto';
import { ALL_POWERS, TERRITORIES, TERRITORY_MAP } from '@diplomacy/shared';
import type { AdjudicationResult, Coast, GameState, Phase, Power, Season, Unit } from '@diplomacy/shared';
import { validateBoardWithGodip } from '../adjudication/GodipAdjudicator.js';

/** Rules only: never serialize sessions, player identities, prompts or chat. */
export interface BoardFixture {
  schemaVersion: 1;
  variant: 'CLASSICAL';
  rulesEngine: 'godip@v0.6.5';
  powers: Power[];
  year: number;
  season: Season;
  phase: Phase;
  territoryOwners: Record<string, Power | null>;
  units: Unit[];
  retreatContext: NonNullable<AdjudicationResult['retreatContext']> | null;
}

export class FixtureError extends Error {
  constructor(readonly diagnostics: string[]) {
    super(`Invalid fixture:\n${diagnostics.join('\n')}`);
    this.name = 'FixtureError';
  }
}
const fail = (path: string, message: string): never => { throw new FixtureError([`${path}: ${message}`]); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value as Record<string, unknown>;
}
function fields(value: unknown, keys: string[], path: string): Record<string, unknown> {
  const result = object(value, path);
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  for (const key of keys) if (!Object.hasOwn(result, key)) fail(`${path}.${key}`, 'required field');
  return result;
}
function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `expected an array with at most ${max} items`);
  return value as unknown[];
}
function member<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `expected one of ${allowed.join(', ')}`);
  return value as T;
}
function province(value: unknown, path: string): string {
  if (typeof value !== 'string' || !Object.hasOwn(TERRITORY_MAP, value)) fail(path, 'unknown province');
  return value as string;
}
function coast(value: unknown, path: string): Coast | null {
  return value === null ? null : member(value, ['NORTH', 'SOUTH', 'EAST', 'WEST'] as const, path);
}
function unique(values: string[], path: string) {
  if (new Set(values).size !== values.length) fail(path, 'duplicate values');
}

/** Strict structural validation; importBoard also checks Godip rules. */
export function parseBoard(input: unknown): BoardFixture {
  const root = fields(input, ['schemaVersion', 'variant', 'rulesEngine', 'powers', 'year', 'season', 'phase', 'territoryOwners', 'units', 'retreatContext'], 'board');
  if (root.schemaVersion !== 1) fail('board.schemaVersion', 'only version 1 is supported');
  if (root.variant !== 'CLASSICAL') fail('board.variant', 'only CLASSICAL is supported');
  if (root.rulesEngine !== 'godip@v0.6.5') fail('board.rulesEngine', 'expected godip@v0.6.5');
  const powers = array(root.powers, 'board.powers', 7).map((value, i) => member(value, ALL_POWERS, `board.powers[${i}]`));
  unique(powers, 'board.powers');
  if (powers.length !== 7) fail('board.powers', 'all seven classical powers are required (including eliminated powers)');
  if (!Number.isSafeInteger(root.year) || Number(root.year) < 1 || Number(root.year) > 9999) fail('board.year', 'expected an integer between 1 and 9999');
  const season = member(root.season, ['SPRING', 'FALL', 'WINTER'] as const, 'board.season');
  const phase = member(root.phase, ['ORDERS', 'RETREATS', 'BUILDS'] as const, 'board.phase');
  if ((phase === 'BUILDS') !== (season === 'WINTER')) fail('board.phase', 'BUILDS requires WINTER; ORDERS/RETREATS require SPRING or FALL');
  const owners = fields(root.territoryOwners, TERRITORIES.map(t => t.id), 'board.territoryOwners');
  const territoryOwners = Object.fromEntries(TERRITORIES.map(t => {
    const owner = owners[t.id] === null ? null : member(owners[t.id], ALL_POWERS, `board.territoryOwners.${t.id}`);
    if (t.type === 'SEA' && owner !== null) fail(`board.territoryOwners.${t.id}`, 'sea provinces cannot be owned');
    return [t.id, owner];
  }));
  const units = array(root.units, 'board.units', 150).map((value, i): Unit => {
    const path = `board.units[${i}]`;
    const unit = fields(value, ['id', 'type', 'power', 'territory', 'coast', 'mustRetreat', 'retreatOptions', 'retreatCoasts', 'dislodgedBy'], path);
    if (typeof unit.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(unit.id)) fail(`${path}.id`, 'expected 1–100 letters, digits, underscores or hyphens');
    const type = member(unit.type, ['ARMY', 'FLEET'] as const, `${path}.type`);
    const territory = province(unit.territory, `${path}.territory`);
    const unitCoast = coast(unit.coast, `${path}.coast`);
    const terrain = TERRITORY_MAP[territory];
    if (type === 'ARMY' && (terrain.type === 'SEA' || unitCoast !== null)) fail(path, 'army requires land and no coast suffix');
    if (type === 'FLEET' && (terrain.type === 'LAND' || (terrain.coasts.length > 0 ? !unitCoast || !terrain.coasts.includes(unitCoast) : unitCoast !== null))) fail(path, 'fleet requires sea/coastal terrain and a valid explicit coast on split-coast provinces');
    if (typeof unit.mustRetreat !== 'boolean') fail(`${path}.mustRetreat`, 'expected boolean');
    const retreatOptions = array(unit.retreatOptions, `${path}.retreatOptions`, 75).map((p, j) => province(p, `${path}.retreatOptions[${j}]`));
    unique(retreatOptions, `${path}.retreatOptions`);
    const retreatCoasts = Object.fromEntries(Object.entries(object(unit.retreatCoasts, `${path}.retreatCoasts`)).map(([p, values]) => {
      province(p, `${path}.retreatCoasts`);
      if (!retreatOptions.includes(p)) fail(`${path}.retreatCoasts.${p}`, 'province must also be a retreat option');
      const coasts = array(values, `${path}.retreatCoasts.${p}`, 4).map(c => member(c, TERRITORY_MAP[p].coasts, `${path}.retreatCoasts.${p}`));
      unique(coasts, `${path}.retreatCoasts.${p}`);
      if (!coasts.length || type !== 'FLEET') fail(`${path}.retreatCoasts.${p}`, 'requires fleet coast choices');
      return [p, coasts.sort()];
    }));
    const dislodgedBy = unit.dislodgedBy === null ? null : province(unit.dislodgedBy, `${path}.dislodgedBy`);
    if (unit.mustRetreat) {
      if (phase !== 'RETREATS' || retreatOptions.length === 0) fail(path, 'retreating units require a retreat phase and legal destinations');
    } else if (dislodgedBy !== null || retreatOptions.length || Object.keys(retreatCoasts).length) fail(path, 'active units cannot carry retreat metadata');
    return { id: unit.id as string, type, power: member(unit.power, ALL_POWERS, `${path}.power`), territory, coast: unitCoast, mustRetreat: unit.mustRetreat as boolean, retreatOptions: retreatOptions.sort(), retreatCoasts, dislodgedBy };
  });
  unique(units.map(u => u.id), 'board.units.id');
  unique(units.filter(u => !u.mustRetreat).map(u => u.territory), 'board.units.activeOccupancy');
  unique(units.filter(u => u.mustRetreat).map(u => u.territory), 'board.units.retreatOccupancy');
  if (phase === 'RETREATS' && !units.some(u => u.mustRetreat)) fail('board.phase', 'RETREATS requires at least one retreating unit');
  let retreatContext: BoardFixture['retreatContext'] = null;
  if (root.retreatContext !== null) {
    if (phase !== 'RETREATS') fail('board.retreatContext', 'only valid during RETREATS');
    const context = fields(root.retreatContext, ['dislodgers', 'bounces'], 'board.retreatContext');
    const dislodgers = Object.fromEntries(Object.entries(object(context.dislodgers, 'board.retreatContext.dislodgers')).map(([source, target]) => [province(source, 'board.retreatContext.dislodgers'), province(target, 'board.retreatContext.dislodgers')]));
    const bounces = Object.fromEntries(Object.entries(object(context.bounces, 'board.retreatContext.bounces')).map(([target, sources]) => {
      province(target, 'board.retreatContext.bounces');
      const list = array(sources, `board.retreatContext.bounces.${target}`, 75).map(p => province(p, `board.retreatContext.bounces.${target}`));
      unique(list, `board.retreatContext.bounces.${target}`);
      return [target, list.sort()];
    }));
    retreatContext = { dislodgers, bounces };
  } else if (phase === 'RETREATS') fail('board.retreatContext', 'complete Godip retreat context is required');
  return { schemaVersion: 1, variant: 'CLASSICAL', rulesEngine: 'godip@v0.6.5', powers: [...ALL_POWERS], year: root.year as number, season, phase, territoryOwners, units: units.sort((a,b) => compare(a.id, b.id)), retreatContext };
}

export async function importBoard(input: unknown): Promise<BoardFixture> {
  const board = parseBoard(input);
  const engineUnit = (u: Unit) => ({ id: u.id, type: u.type, power: u.power, territory: u.territory, coast: u.coast ?? undefined });
  const errors = await validateBoardWithGodip({
    operation: 'VALIDATE_BOARD', year: board.year, season: board.season, phase: board.phase,
    units: board.units.filter(u => !u.mustRetreat).map(engineUnit),
    supplyCenters: Object.fromEntries(TERRITORIES.filter(t => t.isSupplyCenter).map(t => [t.id, board.territoryOwners[t.id] ?? ''])),
    dislodged: board.units.filter(u => u.mustRetreat).map(u => ({ ...engineUnit(u), dislodgedBy: u.dislodgedBy,
      retreatOptions: u.retreatOptions.flatMap(territory => u.retreatCoasts[territory]?.length
        ? u.retreatCoasts[territory]!.map(coast => ({ territory, coast })) : [{ territory }]),
    })),
    retreatContext: board.retreatContext,
    orders: [],
  });
  if (errors.length) throw new FixtureError(errors.map(error => `Godip: ${error}`));
  return board;
}

export function exportBoard(state: GameState): BoardFixture {
  return parseBoard({
    schemaVersion: 1, variant: 'CLASSICAL', rulesEngine: 'godip@v0.6.5', powers: ALL_POWERS,
    year: state.year, season: state.season, phase: state.phase,
    territoryOwners: Object.fromEntries(Object.values(state.territories).map(t => [t.id, t.owner])),
    units: state.units,
    retreatContext: state.phase === 'RETREATS' ? state.lastAdjudicationResult?.retreatContext ?? null : null,
  });
}

/** Stable output makes review, content hashes and repeated offline runs comparable. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => compare(a,b)).map(([k,v]) => [k,sort(v)])) : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
export function boardHash(board: BoardFixture): string {
  return createHash('sha256').update(canonicalJson(parseBoard(board))).digest('hex');
}

/** Shared strict parsing helpers for the local scenario envelope. */
export const fixtureSchema = { fail, fields, object, array, member, province, coast, unique };
