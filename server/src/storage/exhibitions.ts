import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson, parseBoard } from '../fixtures/BoardFixture.js';
import { publicBoard, publicReport } from './publicData.js';
import { StoreError, type StoredExhibition, type StoreOperations } from './contracts.js';

const invalid = (): never => { throw new StoreError('STORE_INVALID','Invalid exhibition request.'); };
const conflict = (message = 'This exhibition changed. Reload it.'): never => { throw new StoreError('STORE_CONFLICT',message); };
const time = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) invalid(); };
const ident = (s: string) => { if (typeof s !== 'string' || !/^[A-Za-z0-9:_-]{1,100}$/.test(s)) invalid(); };
/** How many times the same position may recur before the game is called a draw. */
const REPEAT_LIMIT = 3;

/** Methods run inside the worker transaction. Everything stored here is already public. */
export class ExhibitionRepository {
  constructor(private db: DatabaseSync) {}
  private row(r: Record<string, unknown>): StoredExhibition {
    return { id:String(r.id), challengeId:String(r.challenge_id), challengeVersion:Number(r.challenge_version), state:r.state as StoredExhibition['state'], reason:r.reason === null ? null : String(r.reason),
      board:parseBoard(JSON.parse(String(r.board_json))), phases:Number(r.phases), maxPhases:Number(r.max_phases), quietPhases:Number(r.quiet_phases), createdAt:Number(r.created_at), updatedAt:Number(r.updated_at) };
  }
  get(id: string): StoredExhibition | null {
    ident(id);
    const r = this.db.prepare('SELECT * FROM exhibitions WHERE id=?').get(id);
    return r ? this.row(r) : null;
  }
  list(input: StoreOperations['exhibitions']['input']): StoredExhibition[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) invalid();
    return this.db.prepare('SELECT * FROM exhibitions WHERE (?1 IS NULL OR state=?1) ORDER BY created_at DESC,id LIMIT ?2').all(input.state ?? null,input.limit).map(r => this.row(r));
  }
  reports(id: string) {
    ident(id);
    return this.db.prepare('SELECT report_json FROM exhibition_reports WHERE exhibition_id=? ORDER BY sequence').all(id).map(r => JSON.parse(String(r.report_json)));
  }
  create(input: StoreOperations['createExhibition']['input']): StoredExhibition {
    ident(input.id); ident(input.createdBy); time(input.now);
    if (!Number.isSafeInteger(input.maxPhases) || input.maxPhases < 1 || input.maxPhases > 200 || !Number.isSafeInteger(input.maxRunning) || input.maxRunning < 1 || input.maxRunning > 10) invalid();
    const existing = this.get(input.id);
    if (existing) return existing;
    const challenge = this.db.prepare('SELECT board_json FROM challenges WHERE id=? AND version=?').get(input.challengeId,input.challengeVersion);
    if (!challenge) invalid();
    // Paused games still hold a slot: the bound is on games that exist unfinished, not on CPU in use this second.
    if (Number(this.db.prepare("SELECT count(*) n FROM exhibitions WHERE state IN ('RUNNING','PAUSED')").get()!.n) >= input.maxRunning) conflict('The limit of unfinished exhibition games is reached. Finish or cancel one first.');
    this.db.prepare("INSERT INTO exhibitions(id,challenge_id,challenge_version,state,board_json,max_phases,created_at,updated_at,created_by) VALUES(?,?,?,'RUNNING',?,?,?,?,?)")
      .run(input.id,input.challengeId,input.challengeVersion,String(challenge!.board_json),input.maxPhases,input.now,input.now,input.createdBy);
    return this.get(input.id)!;
  }
  setState(input: StoreOperations['setExhibitionState']['input']): StoredExhibition {
    time(input.now);
    const current = this.get(input.id) ?? conflict('Exhibition not found.');
    const next = input.action === 'PAUSE' && current.state === 'RUNNING' ? ['PAUSED',null] : input.action === 'RESUME' && current.state === 'PAUSED' ? ['RUNNING',null]
      : input.action === 'CANCEL' && ['RUNNING','PAUSED'].includes(current.state) ? ['CANCELLED','CANCELLED_BY_OPERATOR'] : input.action === 'FAIL' && current.state === 'RUNNING' ? ['FAILED','RULES_ENGINE_ERROR'] : null;
    // Repeating an action that already took effect is harmless; anything else on a finished game is refused.
    if (!next) { if ((input.action === 'PAUSE' && current.state === 'PAUSED') || (input.action === 'RESUME' && current.state === 'RUNNING') || (input.action === 'CANCEL' && current.state === 'CANCELLED')) return current; return conflict('This exhibition has finished.'); }
    this.db.prepare('UPDATE exhibitions SET state=?,reason=?,updated_at=? WHERE id=?').run(next[0],next[1],input.now,input.id);
    return this.get(input.id)!;
  }
  /**
   * Commits exactly one resolved phase. `expectedPhases` is the fence: after a restart, or with two
   * runners, only the first commit for a given phase number succeeds.
   */
  advance(input: StoreOperations['advanceExhibition']['input']): StoredExhibition {
    time(input.now);
    if (!Number.isSafeInteger(input.quietLimit) || input.quietLimit < 1 || input.quietLimit > 200) invalid();
    const current = this.get(input.id) ?? conflict('Exhibition not found.');
    if (current.state !== 'RUNNING' || current.phases !== input.expectedPhases) conflict();
    const board = parseBoard(input.board), report = { ...publicReport(input.report), id:`${input.id}:${current.phases + 1}`, sequence:current.phases + 1 };
    if (canonicalJson(report.before) !== canonicalJson(publicBoard(current.board)) || canonicalJson(report.after) !== canonicalJson(publicBoard(board))) conflict('Report does not follow the stored position.');
    this.db.prepare('INSERT INTO exhibition_reports(exhibition_id,sequence,report_json) VALUES(?,?,?)').run(input.id,report.sequence,canonicalJson(report));
    const phases = current.phases + 1, moved = canonicalJson(current.board.territoryOwners) !== canonicalJson(board.territoryOwners) || current.board.units.length !== board.units.length;
    const quiet = moved ? 0 : current.quietPhases + 1;
    // A position is who stands where and who owns what at a given point in the year.
    const signature = createHash('sha256').update(canonicalJson([board.season,board.phase,board.territoryOwners,board.units.map(u => [u.power,u.type,u.territory,u.coast]).sort()])).digest('hex').slice(0,16);
    const recent = [...JSON.parse(String(this.db.prepare('SELECT recent_json FROM exhibitions WHERE id=?').get(input.id)!.recent_json)) as string[],signature].slice(-24);
    const [state,reason] = input.finished ? ['COMPLETED','GAME_OVER'] : recent.filter(s => s === signature).length >= REPEAT_LIMIT ? ['STALLED','REPEATED_POSITION']
      : quiet >= input.quietLimit ? ['STALLED','NO_PROGRESS'] : phases >= current.maxPhases ? ['COMPLETED','PHASE_LIMIT'] : ['RUNNING',null];
    this.db.prepare('UPDATE exhibitions SET board_json=?,phases=?,quiet_phases=?,recent_json=?,state=?,reason=?,updated_at=? WHERE id=?').run(canonicalJson(board),phases,quiet,JSON.stringify(recent),state,reason,input.now,input.id);
    return this.get(input.id)!;
  }
}
