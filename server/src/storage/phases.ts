import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson, parseBoard } from '../fixtures/BoardFixture.js';
import { parseAction, parseDecisions } from '../attempts/actions.js';
import type { PhaseFence, PhaseJob } from '../attempts/types.js';
import { parseChallenge } from './publicData.js';
import { StoreError, type StoredAttempt, type StoredChallenge, type StoredReceipt, type StoreOperations } from './contracts.js';

type Hooks = {
  attempt(id: string): StoredAttempt | null;
  challenge(id: string, version: number): StoredChallenge | null;
  receipt(attemptId: string, playerId: string, requestId: string): StoredReceipt | null;
  writeReceipt(receipt: StoredReceipt, finalize?: boolean): StoredReceipt;
  checkpoint(input: StoreOperations['checkpoint']['input']): StoredAttempt;
};
const conflict = (): never => { throw new StoreError('STORE_CONFLICT', 'This phase changed or is already closed. Reload its committed state.'); };
const invalid = (): never => { throw new StoreError('STORE_INVALID', 'Invalid phase operation.'); };
const text = (s: string) => { if (typeof s !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(s)) invalid(); };
const time = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) invalid(); };
export const actionFingerprint = (phaseId: string, action: unknown): string => createHash('sha256').update(canonicalJson({phaseId, action: parseAction(action)})).digest('hex');

/** All methods run inside the worker's BEGIN IMMEDIATE transaction. */
export class PhaseRepository {
  constructor(private db: DatabaseSync, private hooks: Hooks) {}
  get(operationId: string): PhaseJob | null {
    const r = this.db.prepare('SELECT * FROM phase_jobs WHERE id=?').get(operationId);
    return r ? { operationId: String(r.id), attemptId: String(r.attempt_id), phaseId: String(r.phase_id), revision: Number(r.revision),
      status: r.status as PhaseJob['status'], playerId: String(r.player_id), requestId: String(r.request_id),
      board: parseBoard(JSON.parse(String(r.board_json))), definition: parseChallenge(JSON.parse(String(r.definition_json))),
      humanAction: parseAction(JSON.parse(String(r.human_action_json))), decisions: r.decisions_json === null ? null : parseDecisions(JSON.parse(String(r.decisions_json))),
      reportOffset: Number(r.report_offset), createdAt: Number(r.created_at) } : null;
  }
  pending(): PhaseJob[] {
    const rows = this.db.prepare("SELECT id FROM phase_jobs WHERE status IN ('DECIDING','RESOLVING','RECOVERING') ORDER BY created_at LIMIT 101").all();
    if (rows.length > 100) throw new StoreError('STORE_UNAVAILABLE', 'Pending phase count exceeds the recovery bound.');
    return rows.map(r => this.get(String(r.id))!);
  }
  private owner(attempt: StoredAttempt | null, playerId: string): asserts attempt is StoredAttempt {
    if (!attempt || attempt.playerId !== playerId || !this.db.prepare('SELECT id FROM players WHERE id=? AND banned_at IS NULL').get(playerId))
      throw new StoreError('STORE_FORBIDDEN', 'Attempt is unavailable to this player.');
  }
  private current(fence: PhaseFence): {job: PhaseJob; attempt: StoredAttempt} {
    const job = this.get(fence.operationId), attempt = this.hooks.attempt(fence.attemptId);
    if (!job || !attempt || job.attemptId !== fence.attemptId || job.phaseId !== fence.phaseId || job.revision !== fence.revision ||
      attempt.revision !== fence.revision || attempt.phaseId !== fence.phaseId || attempt.lifecycle !== 'ACTIVE' ||
      job.status === 'COMMITTED' || job.status === 'CANCELLED') conflict();
    this.owner(attempt, job!.playerId);
    return {job: job!, attempt: attempt!};
  }
  begin(input: StoreOperations['beginPhase']['input']): StoreOperations['beginPhase']['output'] {
    time(input.now); text(input.operationId); text(input.requestId);
    const action = parseAction(input.action), attempt = this.hooks.attempt(input.id);
    this.owner(attempt, input.playerId);
    const fingerprint = actionFingerprint(input.phaseId, action);
    const existing = this.hooks.receipt(input.id, input.playerId, input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new StoreError('STORE_CONFLICT', 'Request ID was already used for a different submission.');
      const row = this.db.prepare('SELECT id FROM phase_jobs WHERE attempt_id=? AND player_id=? AND request_id=?').get(input.id,input.playerId,input.requestId);
      if (!row) conflict();
      return {job: this.get(String(row!.id))!, receipt: existing, duplicate: true};
    }
    if (input.idleBefore !== undefined && attempt.lastActivityAt <= input.idleBefore) conflict();
    if (attempt.lifecycle !== 'ACTIVE' || attempt.execution !== 'ACCEPTING' || attempt.revision !== input.expectedRevision || attempt.phaseId !== input.phaseId || attempt.board.phase !== action.phase) conflict();
    const definition = this.hooks.challenge(attempt.challengeId,attempt.challengeVersion)!.definition;
    const revision = attempt.revision + 1;
    const offset = Number(this.db.prepare('SELECT count(*) AS n FROM reports WHERE attempt_id=?').get(attempt.id)!.n);
    const receipt = this.hooks.writeReceipt({attemptId: attempt.id,playerId: input.playerId,fingerprint,createdAt: input.now,
      state: {phaseId: input.phaseId,requestId: input.requestId,status: 'SUBMITTING',error: null}});
    this.db.prepare(`INSERT INTO phase_jobs(id,attempt_id,phase_id,revision,status,player_id,request_id,board_json,definition_json,human_action_json,report_offset,created_at)
      VALUES(?,?,?,?,'DECIDING',?,?,?,?,?,?,?)`).run(input.operationId,attempt.id,input.phaseId,revision,input.playerId,input.requestId,canonicalJson(attempt.board),canonicalJson(definition),canonicalJson(action),offset,input.now);
    this.db.prepare("UPDATE attempts SET execution='DECIDING',revision=?,updated_at=? WHERE id=?").run(revision,input.now,attempt.id);
    return {job: this.get(input.operationId)!,receipt,duplicate:false};
  }
  decisions(input: StoreOperations['saveDecisions']['input']): PhaseJob {
    time(input.now);
    const {job} = this.current(input.fence);
    if (job.decisions !== null) conflict();
    const decisions = parseDecisions(input.decisions);
    if (Object.keys(decisions).length !== 6 || job.definition.opponentPowers.some(p => !decisions[p]) ||
      Object.values(decisions).some(a => a!.phase !== job.board.phase)) invalid();
    this.db.prepare("UPDATE phase_jobs SET decisions_json=?,status='RESOLVING',revision=revision+1 WHERE id=?").run(canonicalJson(decisions),job.operationId);
    this.db.prepare("UPDATE attempts SET execution='RESOLVING',revision=revision+1,updated_at=? WHERE id=?").run(input.now,job.attemptId);
    return this.get(job.operationId)!;
  }
  recover(input: StoreOperations['recoverPhase']['input']): PhaseJob {
    time(input.now);
    const {job} = this.current(input.fence);
    this.db.prepare("UPDATE phase_jobs SET status='RECOVERING',revision=revision+1 WHERE id=?").run(job.operationId);
    this.db.prepare("UPDATE attempts SET execution='RECOVERING',revision=revision+1,updated_at=? WHERE id=?").run(input.now,job.attemptId);
    const receipt = this.hooks.receipt(job.attemptId,job.playerId,job.requestId)!;
    this.hooks.writeReceipt({...receipt,state:{...receipt.state,error:{code:'RECOVERY_REQUIRED',message:'Orders are saved. Phase processing was interrupted and can be recovered.'}}},true);
    return this.get(job.operationId)!;
  }
  commit(input: StoreOperations['commitPhase']['input']): StoredAttempt {
    time(input.now);
    const existing = this.get(input.fence.operationId);
    if (existing?.status === 'COMMITTED' && existing.attemptId === input.fence.attemptId && existing.phaseId === input.fence.phaseId && existing.revision === input.fence.revision)
      return this.hooks.attempt(existing.attemptId)!;
    const {job} = this.current(input.fence);
    if (!job.decisions || input.reports.length !== 1 || input.reports[0].id !== job.operationId || input.reports[0].sequence !== job.reportOffset+1) invalid();
    const receipt = this.hooks.receipt(job.attemptId,job.playerId,job.requestId)!;
    const result = this.hooks.checkpoint({id:job.attemptId,expectedRevision:job.revision,expectedPhaseId:job.phaseId,board:input.board,
      lifecycle:input.finished?'COMPLETED':'ACTIVE',execution:'ACCEPTING',reports:input.reports,
      receipt:{...receipt,state:{...receipt.state,status:'ACCEPTED',error:null}},now:input.now});
    this.db.prepare("UPDATE phase_jobs SET status='COMMITTED' WHERE id=?").run(job.operationId);
    return result;
  }
  terminate(input: StoreOperations['terminateAttempt']['input']): StoredAttempt {
    time(input.now);
    if (!['ABANDONED','EXPIRED','STOPPED'].includes(input.lifecycle)) invalid();
    const attempt = this.hooks.attempt(input.id);
    this.owner(attempt,input.playerId);
    if (attempt.lifecycle !== 'ACTIVE') return attempt;
    if (input.lifecycle === 'EXPIRED' && input.idleBefore !== undefined && attempt.lastActivityAt > input.idleBefore) return attempt;
    const result = this.hooks.checkpoint({id:attempt.id,expectedRevision:attempt.revision,expectedPhaseId:attempt.phaseId,board:attempt.board,
      lifecycle:input.lifecycle,execution:'IDLE',reports:[],now:input.now});
    this.cancel(attempt.id);
    return result;
  }
  cancel(attemptId: string): void {
    for (const row of this.db.prepare("SELECT * FROM phase_jobs WHERE attempt_id=? AND status IN ('DECIDING','RESOLVING','RECOVERING')").all(attemptId)) {
      const receipt = this.hooks.receipt(attemptId,String(row.player_id),String(row.request_id));
      if (receipt) this.db.prepare('UPDATE receipts SET state_json=? WHERE attempt_id=? AND player_id=? AND request_id=?').run(
        canonicalJson({...receipt.state,status:'FAILED',error:{code:'ATTEMPT_CLOSED',message:'This attempt was closed before its phase completed.'}}),attemptId,String(row.player_id),String(row.request_id));
    }
    this.db.prepare("UPDATE phase_jobs SET status='CANCELLED' WHERE attempt_id=? AND status IN ('DECIDING','RESOLVING','RECOVERING')").run(attemptId);
  }
}
