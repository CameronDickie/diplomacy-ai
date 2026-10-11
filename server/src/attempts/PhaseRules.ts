import { ALL_POWERS, gamePhaseId, TERRITORIES } from '@diplomacy/shared';
import type { Order, Power, PublicPhaseReport } from '@diplomacy/shared';
import { GameRoom } from '../GameRoom.js';
import { exportBoard, type BoardFixture } from '../fixtures/BoardFixture.js';
import type { PhaseAction, PhaseDecisions, PhaseJob } from './types.js';
import { parseAction } from './actions.js';
import { StoreError } from '../storage/contracts.js';

/** A disposable, all-human room is a rules adapter only: no IO, LLM seats or live authority. */
async function roomFor(board: BoardFixture, signal: AbortSignal): Promise<GameRoom> {
  signal.throwIfAborted();
  const room = await GameRoom.fromBoardFixture(board);
  if (signal.aborted) { room.dispose(); signal.throwIfAborted(); }
  signal.addEventListener('abort', () => room.dispose(), {once:true});
  for (const power of ALL_POWERS) room.addPlayer(power,power,power);
  return room;
}
const invalid = (message: string): never => { throw new StoreError('STORE_INVALID', message); };
const delta = (board: BoardFixture, power: Power) => TERRITORIES.filter(t => t.isSupplyCenter && board.territoryOwners[t.id] === power).length - board.units.filter(u => u.power === power).length;

async function validate(room: GameRoom, power: Power, input: PhaseAction): Promise<Order[]> {
  const action = parseAction(input);
  if (action.phase !== room.getState().phase) invalid('Choice does not match the current phase.');
  if (action.phase === 'ORDERS') {
    const catalog = new Map((await room.getLegalOrders(power)).map(o => [o.id,o.order]));
    const orders = action.orderIds.map(id => catalog.get(id) ?? invalid('Choose an order from the current legal catalog.'));
    const units = room.getState().units.filter(u => u.power === power && !u.mustRetreat);
    if (orders.length !== units.length || new Set(orders.map(o => o.unitTerritory)).size !== units.length) invalid('Choose exactly one legal order for each active unit.');
    return orders;
  }
  const error = action.phase === 'RETREATS' ? room.validateRetreats(power,action.retreats)
    : room.validateBuilds(power,{gameId:room.gameId,builds:action.builds,disbands:action.disbands});
  if (error) invalid(error);
  return [];
}
/**
 * The only action a power can take when a phase asks nothing of it, or null when it has a real
 * decision to make. Derived from the committed board alone.
 */
export function idleAction(board: BoardFixture, power: Power): PhaseAction | null {
  if (board.phase === 'ORDERS') return board.units.some(u => u.power === power && !u.mustRetreat) ? null : {phase:'ORDERS',orderIds:[]};
  if (board.phase === 'RETREATS') return board.units.some(u => u.power === power && u.mustRetreat) ? null : {phase:'RETREATS',retreats:{}};
  return delta(board,power) === 0 ? {phase:'BUILDS',builds:[],disbands:[]} : null;
}
export class PhaseRules {
  async validate(board: BoardFixture, power: Power, action: PhaseAction, signal: AbortSignal): Promise<void> {
    const room = await roomFor(board,signal);
    try { await validate(room,power,action); signal.throwIfAborted(); }
    finally { room.dispose(); }
  }
  async legal(board: BoardFixture, power: Power, signal: AbortSignal) {
    const room = await roomFor(board,signal);
    try { const options = await room.getLegalOrders(power); signal.throwIfAborted(); return options; }
    finally { room.dispose(); }
  }
  async validateDecisions(job: PhaseJob, decisions: PhaseDecisions, signal: AbortSignal): Promise<void> {
    if (Object.keys(decisions).length !== 6 || job.definition.opponentPowers.some(p => !decisions[p])) invalid('Expected one decision per opponent.');
    const room = await roomFor(job.board,signal);
    try {
      for (const power of job.definition.opponentPowers) { signal.throwIfAborted(); await validate(room,power,decisions[power]!); }
    } finally { room.dispose(); }
  }
  async defaults(job: PhaseJob, signal: AbortSignal): Promise<PhaseDecisions> {
    const room = await roomFor(job.board,signal);
    try {
      const decisions: PhaseDecisions = {};
      for (const power of job.definition.opponentPowers) {
        signal.throwIfAborted();
        const phase = job.board.phase;
        if (phase === 'ORDERS') decisions[power] = {phase,orderIds:(await room.getLegalOrders(power)).filter(o => o.order.type === 'HOLD').map(o => o.id)};
        else if (phase === 'RETREATS') decisions[power] = {phase,retreats:Object.fromEntries(job.board.units.filter(u => u.power === power && u.mustRetreat).map(u => [u.id,null]))};
        else decisions[power] = {phase,builds:[],disbands:job.board.units.filter(u => u.power === power).map(u => u.id).sort().slice(0,Math.max(0,-delta(job.board,power)))};
      }
      return decisions;
    } finally { room.dispose(); }
  }
  async resolve(job: PhaseJob, signal: AbortSignal): Promise<{board: BoardFixture; reports: PublicPhaseReport[]; finished: boolean}> {
    if (!job.decisions) invalid('Opponent decisions are not saved.');
    const room = await roomFor(job.board,signal);
    try {
      const actions = {...job.decisions,[job.definition.humanPower]:job.humanAction};
      const orders = new Map<Power,Order[]>();
      for (const power of ALL_POWERS) orders.set(power,await validate(room,power,actions[power]!));
      signal.throwIfAborted();
      await room.startGame();
      const phaseId = gamePhaseId(room.getState());
      const needed = ALL_POWERS.filter(p => job.board.phase === 'ORDERS' ? job.board.units.some(u => u.power === p && !u.mustRetreat)
        : job.board.phase === 'RETREATS' ? job.board.units.some(u => u.power === p && u.mustRetreat) : delta(job.board,p) !== 0);
      // An imported zero-adjustment winter still needs an explicit phase advance.
      if (!needed.length && job.board.phase === 'BUILDS') needed.push('AUSTRIA');
      for (const power of needed) {
        signal.throwIfAborted();
        const action = actions[power]!;
        const outcome = await room.submitCommand(power,{phaseId,requestId:`phase-${power}`,...(action.phase === 'ORDERS' ? {phase:'ORDERS' as const,orders:orders.get(power)!} : action)});
        if (outcome.status !== 'ACCEPTED') throw new Error('Rules resolution did not complete.');
      }
      signal.throwIfAborted();
      const reports = room.getPhaseHistory();
      if (reports.length !== 1) throw new Error('Expected exactly one resolved phase.');
      const report = {...reports[0],id:job.operationId,sequence:job.reportOffset+1,resolvedAt:new Date(job.createdAt).toISOString()};
      return {board:exportBoard(room.getState()),reports:[report],finished:room.getState().status === 'FINISHED'};
    } finally { room.dispose(); }
  }
}
