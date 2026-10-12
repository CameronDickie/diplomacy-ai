import { ProviderCallRepository } from './providerCalls.js';
import { ChatRepository } from './chat.js';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { gamePhaseId } from '@diplomacy/shared';
import type { PublicPhaseReport, SubmissionState } from '@diplomacy/shared';
import { canonicalJson, parseBoard } from '../fixtures/BoardFixture.js';
import { scoreChallenge } from '../challenge/TunisPilot.js';
import { TalkRepository } from './talks.js';
import { migrate, verifyMigrationHistory } from './migrations.js';
import { PhaseRepository } from './phases.js';
import { RetentionRepository } from './retention.js';
import { OperatorRepository, paidState, stopPaid } from './operator.js';
import { OutboxRepository } from './outbox.js';
import { FundingRepository } from './funding.js';
import { EvaluationRepository } from './evaluation.js';
import { ExhibitionRepository } from './exhibitions.js';
import type { StoreOperations } from './contracts.js';
import { parseChallenge, publicBoard, publicReport } from './publicData.js';
import { StoreError, type StoreRequest, type StoredAttempt, type StoredPlayer, type StoredReceipt, type StoredChallenge } from './contracts.js';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
const invalid = (message: string): never => { throw new StoreError('STORE_INVALID', message); };
const conflict = (message: string): never => { throw new StoreError('STORE_CONFLICT', message); };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const validHash = (v: string) => { if (!/^[a-f0-9]{64}$/.test(v)) invalid('Expected a SHA-256 digest.'); };
const validText = (v: string, max = 200) => { if (typeof v !== 'string' || v.length < 1 || v.length > max) invalid('Invalid text field.'); };
const validTime = (v: number) => { if (!Number.isSafeInteger(v) || v < 0) invalid('Invalid timestamp.'); };
const safeFile = (path: string, exclusive = false) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) {
    if (exclusive || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) invalid('Database path must be a regular file.');
  }
  chmodSync(path, 0o600);
};
const location = resolve(workerData.path);
let db: DatabaseSync;
let schemaVersion = 0;
const boot = (async () => {
  if (workerData.readOnly) {
    if (!lstatSync(location).isFile() || lstatSync(location).isSymbolicLink()) invalid('Database path must be a regular file.');
  } else safeFile(location, Boolean(workerData.restoreFrom));
  if (workerData.restoreFrom) {
    const source = new DatabaseSync(resolve(workerData.restoreFrom), { readOnly: true });
    try {
      if (source.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') invalid('Backup integrity check failed.');
      verifyMigrationHistory(source, true);
      if (source.prepare('PRAGMA foreign_key_check').all().length) invalid('Backup has invalid foreign-key references.');
      await backup(source, location);
    } finally { source.close(); }
  }
  db = new DatabaseSync(location, { readOnly: Boolean(workerData.readOnly), timeout: 250, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  db.exec('PRAGMA trusted_schema=OFF;');
  if (workerData.readOnly) schemaVersion = verifyMigrationHistory(db, true);
  else {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    schemaVersion = migrate(db);
  }
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new StoreError('STORE_SCHEMA', 'Database integrity check failed.');
})();
// Attach a rejection handler immediately: boot can fail before the first RPC.
void boot.catch(() => {});

function transaction<T>(work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function player(row: Row): StoredPlayer {
  return { id: String(row.id), provider: row.provider as StoredPlayer['provider'], subject: String(row.subject), displayName: String(row.display_name), bannedAt: row.banned_at === null ? null : Number(row.banned_at) };
}
function attempt(row: Row): StoredAttempt {
  return { mode: row.opponents === 'LUNA' ? 'SPONSORED' : Number(row.practice_bot) === 1 ? 'BOT' : 'PRACTICE', preset: row.preset_id === null ? null : { id: String(row.preset_id), pricingVersion: String(row.pricing_version) }, id: String(row.id), playerId: String(row.player_id), challengeId: String(row.challenge_id), challengeVersion: Number(row.challenge_version), revision: Number(row.revision), phaseId: String(row.phase_id), lifecycle: row.lifecycle as StoredAttempt['lifecycle'], execution: row.execution as StoredAttempt['execution'], board: parseBoard(JSON.parse(String(row.board_json))), score: row.score_json === null ? null : JSON.parse(String(row.score_json)), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), lastActivityAt: Number(row.last_activity_at) };
}
function getAttempt(id: string): StoredAttempt | null {
  const row = db.prepare('SELECT * FROM attempts WHERE id=?').get(id);
  return row ? attempt(row) : null;
}
function getChallenge(id: string, version: number): StoredChallenge | null {
  const row = db.prepare('SELECT * FROM challenges WHERE id=? AND version=?').get(id,version);
  return row ? { definition: JSON.parse(String(row.definition_json)), board: parseBoard(JSON.parse(String(row.board_json))), hash: String(row.content_hash) } : null;
}
function getReceipt(attemptId: string, playerId: string, requestId: string): StoredReceipt | null {
  const row = db.prepare('SELECT * FROM receipts WHERE attempt_id=? AND player_id=? AND request_id=?').get(attemptId,playerId,requestId);
  return row ? { attemptId, playerId, fingerprint: String(row.fingerprint), state: JSON.parse(String(row.state_json)), createdAt: Number(row.created_at) } : null;
}
function writeReceipt(input: StoredReceipt, finalize = false): StoredReceipt {
  validHash(input.fingerprint); validTime(input.createdAt);
  if (!input.state.requestId) invalid('Receipt requires a request ID.');
  validText(input.state.requestId!, 100);
  const saved = getAttempt(input.attemptId);
  if (!saved || saved.playerId !== input.playerId) throw new StoreError('STORE_FORBIDDEN', 'Attempt is not owned by this player.');
  if (!db.prepare('SELECT id FROM players WHERE id=? AND banned_at IS NULL').get(input.playerId)) throw new StoreError('STORE_FORBIDDEN', 'Player is unavailable.');
  const existing = getReceipt(input.attemptId,input.playerId,input.state.requestId!);
  if (existing) {
    if (existing.fingerprint !== input.fingerprint) conflict('Request ID was already used for a different submission.');
    if (!finalize || existing.state.status !== 'SUBMITTING') return existing;
  }
  if (saved.phaseId !== input.state.phaseId || saved.lifecycle !== 'ACTIVE') conflict('Receipt no longer matches an active phase.');
  if (!['SUBMITTING','ACCEPTED','FAILED'].includes(input.state.status)) invalid('Invalid receipt status.');
  const state: SubmissionState = { phaseId: input.state.phaseId, requestId: input.state.requestId, status: input.state.status,
    error: input.state.error ? {code: input.state.error.code, message: input.state.error.message} : null };
  if (state.error) { validText(state.error.code,100); validText(state.error.message,500); }
  db.prepare(`INSERT INTO receipts(attempt_id,player_id,request_id,fingerprint,state_json,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(attempt_id,player_id,request_id) DO UPDATE SET state_json=excluded.state_json`).run(input.attemptId,input.playerId,state.requestId!,input.fingerprint,canonicalJson(state),input.createdAt);
  if (!existing && state.status !== 'FAILED') db.prepare('UPDATE attempts SET last_activity_at=? WHERE id=?').run(input.createdAt,input.attemptId);
  return { attemptId: input.attemptId, playerId: input.playerId, fingerprint: input.fingerprint, state, createdAt: existing?.createdAt ?? input.createdAt };
}
function reports(id: string): PublicPhaseReport[] {
  return db.prepare('SELECT report_json FROM reports WHERE attempt_id=? ORDER BY sequence').all(id).map(r => JSON.parse(String(r.report_json)));
}

type StartRefusal = { refused: 'SPONSORED_UNAVAILABLE' };
const refuseStart = (result: StoredAttempt | StartRefusal | null): StoredAttempt | null => {
  // Thrown only after COMMIT so the pause recorded when the pool is empty is durable.
  if (result && 'refused' in result) throw new StoreError('SPONSORED_UNAVAILABLE','Sponsored play is out of budget and has been paused. Practice and the replay are still available.');
  return result;
};
function createAttempt(input: StoreOperations['createAttempt']['input']): StoredAttempt | StartRefusal {
  validText(input.id,100); validTime(input.now); validHash(input.reconnectTokenHash);
  const definition = getChallenge(input.challengeId,input.challengeVersion);
  if (!definition) invalid('Unknown challenge version.');
  const owner = db.prepare('SELECT id FROM players WHERE id=? AND banned_at IS NULL').get(input.playerId);
  if (!owner) throw new StoreError('STORE_FORBIDDEN', 'Player is unavailable.');
  const board = definition!.board;
  const phaseId = gamePhaseId({gameId:input.id,...board});
  const sponsored = input.sponsored;
  if (sponsored && input.bot) invalid('An attempt has exactly one kind of opponent.');
  if (sponsored) {
    // Checked in the admission transaction: a sponsored attempt never begins against a paused or empty pool.
    validText(sponsored.preset.id,80); validText(sponsored.preset.pricingVersion,80);
    if (!Number.isSafeInteger(sponsored.minimumAvailableNanousd) || sponsored.minimumAvailableNanousd < 1) invalid('Invalid sponsored start.');
    if (paidState(db).stopped) throw new StoreError('SPONSORED_UNAVAILABLE','Sponsored play is paused. Practice and the replay are still available.');
    if (new FundingRepository(db).totals().availableNanousd < sponsored.minimumAvailableNanousd) {
      stopPaid(db,'BUDGET_EXHAUSTED',input.now);
      return { refused: 'SPONSORED_UNAVAILABLE' as const };
    }
  }
  db.prepare(`INSERT INTO attempts(id,player_id,challenge_id,challenge_version,phase_id,lifecycle,execution,board_json,reconnect_token_hash,created_at,updated_at,last_activity_at,opponents,preset_id,pricing_version,practice_bot)
    VALUES(?,?,?,?,?,'ACTIVE','ACCEPTING',?,?,?,?,?,?,?,?,?)`).run(input.id,input.playerId,input.challengeId,input.challengeVersion,phaseId,canonicalJson(board),input.reconnectTokenHash,input.now,input.now,input.now,
      sponsored ? 'LUNA' : 'HOLD',sponsored?.preset.id ?? null,sponsored?.preset.pricingVersion ?? null,input.bot ? 1 : 0);
  return getAttempt(input.id)!;
}

function phases(): PhaseRepository {
  return new PhaseRepository(db, {attempt:getAttempt,challenge:getChallenge,receipt:getReceipt,writeReceipt,checkpoint});
}
function checkpoint(input: StoreOperations['checkpoint']['input']): StoredAttempt {
  validTime(input.now);
  const current = getAttempt(input.id);
  if (!current || current.revision !== input.expectedRevision || current.phaseId !== input.expectedPhaseId || current.lifecycle !== 'ACTIVE') conflict('Attempt changed or is already terminal. Reload its committed state.');
  if (input.receipt && (input.receipt.attemptId !== input.id || input.receipt.playerId !== current!.playerId || input.receipt.state.phaseId !== input.expectedPhaseId)) conflict('Receipt does not belong to this attempt and phase.');
  const board = parseBoard(input.board);
  if (input.reports.length > 4) invalid('Too many phase reports in one checkpoint.');
  const history = reports(input.id);
  let previousBoard = publicBoard(current!.board);
  for (const [index, rawReport] of input.reports.entries()) {
    const report = publicReport(rawReport);
    if (canonicalJson(report.before) !== canonicalJson(previousBoard)) conflict('Report does not follow the committed board.');
    if (index === 0 && (report.year !== current!.board.year || report.season !== current!.board.season || report.phase !== current!.board.phase)) conflict('Report does not match the committed phase.');
    previousBoard = report.after;
    if (report.sequence !== history.length+1) conflict('Phase reports must be appended in order.');
    db.prepare('INSERT INTO reports(attempt_id,sequence,report_json) VALUES(?,?,?)').run(input.id,report.sequence,canonicalJson(report));
    history.push(report);
  }
  if (canonicalJson(previousBoard) !== canonicalJson(publicBoard(board))) conflict('Checkpoint board does not match committed report history.');
  if (input.reports.length === 0 && canonicalJson(current!.board) !== canonicalJson(board)) conflict('Board changes require a committed phase report.');
  const definition = getChallenge(current!.challengeId,current!.challengeVersion)!.definition;
  const score = scoreChallenge(definition,{challengeId:definition.id,challengeVersion:definition.version,
    lifecycle:input.lifecycle === 'ABANDONED' || input.lifecycle === 'EXPIRED' || input.lifecycle === 'STOPPED' ? 'ABANDONED' : input.lifecycle === 'COMPLETED' ? 'GAME_FINISHED' : 'ACTIVE',reports:history});
  const lifecycle = score.outcome === 'SUCCESS' || score.outcome === 'FAILURE' ? 'COMPLETED' : input.lifecycle;
  if (input.receipt) writeReceipt(input.receipt,true);
  db.prepare(`UPDATE attempts SET board_json=?,phase_id=?,revision=revision+1,lifecycle=?,execution=?,score_json=?,updated_at=? WHERE id=?`).run(
    canonicalJson(board),gamePhaseId({gameId:input.id,...board}),lifecycle,lifecycle === 'ACTIVE' ? input.execution : 'IDLE',canonicalJson(score),input.now,input.id);
  return getAttempt(input.id)!;
}

async function handle(request: StoreRequest): Promise<unknown> {
  await boot;
  const {operation,input} = request;
  switch (operation) {
    case 'prepareProviderCall': {
      // The refusal is thrown only after COMMIT so the stop recorded on exhaustion is durable.
      const prepared = transaction(() => new ProviderCallRepository(db).prepare(input));
      if ('refused' in prepared) throw new StoreError(prepared.refused, prepared.refused === 'BUDGET_EXHAUSTED' ? 'Sponsored play is out of budget and has been paused.'
        : prepared.refused === 'FUNDS_BUSY' ? 'Funds are held by calls of this phase that are still in flight.' : 'This attempt has reached its sponsored budget.');
      return prepared;
    }
    case 'registerEvaluationRun': return transaction(() => new EvaluationRepository(db).register(input));
    case 'evaluationRun': return new EvaluationRepository(db).get(input.runId);
    case 'evaluationPhases': return new EvaluationRepository(db).phases(input.attemptId);
    case 'createEvaluationAttempt': return refuseStart(transaction(() => new EvaluationRepository(db).create(input,getAttempt,createAttempt)));
    case 'saveProviderDecision': return transaction(() => new ProviderCallRepository(db).saveDecision(input));
    case 'chatSend': return transaction(() => new ChatRepository(db).send(input));
    case 'chatReply': return transaction(() => new ChatRepository(db).reply(input));
    case 'chatFail': return transaction(() => new ChatRepository(db).fail(input));
    case 'savePowerTalk': return transaction(() => new TalkRepository(db).save(input));
    case 'powerTalks': return new TalkRepository(db).list(input.attemptId);
    case 'chatMessages': return new ChatRepository(db).list(input.attemptId);
    case 'providerDecisions': return new ProviderCallRepository(db).decisions(input.operationId);
    case 'createExhibition': return transaction(() => new ExhibitionRepository(db).create(input));
    case 'exhibition': return new ExhibitionRepository(db).get(input.id);
    case 'exhibitions': return new ExhibitionRepository(db).list(input);
    case 'exhibitionReports': return new ExhibitionRepository(db).reports(input.id);
    case 'setExhibitionState': return transaction(() => new ExhibitionRepository(db).setState(input));
    case 'advanceExhibition': return transaction(() => new ExhibitionRepository(db).advance(input));
    case 'fundingTotals': return new FundingRepository(db).totals();
    case 'attemptFunding': return new FundingRepository(db).attempt(input.attemptId);
    case 'grantFunding': return transaction(() => new FundingRepository(db).grant(input));
    case 'setFundingPolicy': return transaction(() => new FundingRepository(db).policy(input));
    case 'resolveLiability': return transaction(() => new FundingRepository(db).resolve(input));
    case 'heldLiabilities': return new FundingRepository(db).held();
    case 'releaseProviderCall': return transaction(() => new FundingRepository(db).releasePrepared(input));
    case 'reconcileFunding': return transaction(() => ({released:new FundingRepository(db).reconcile(input.now)}));
    case 'dispatchProviderCall': {
      const dispatched=transaction(() => new ProviderCallRepository(db).dispatch(input));
      if('refused' in dispatched)throw new StoreError(dispatched.refused,'Queued provider call no longer fits the funding policy.');
      return dispatched;
    }
    case 'receiveProviderCall': return transaction(() => new ProviderCallRepository(db).receive(input));
    case 'finishProviderCall': return transaction(() => new ProviderCallRepository(db).finish(input));
    case 'providerCall': return new ProviderCallRepository(db).get(input.id);
    case 'providerCallsForOperation': return new ProviderCallRepository(db).list(input.operationId);
    case 'providerCallsForAttempt': return new ProviderCallRepository(db).forAttempt(input.attemptId);
    case 'providerCallTotals': return new ProviderCallRepository(db).totals(input);
    case 'admitAttempt': return refuseStart(transaction(() => {
      validText(input.id,100); validText(input.requestId,100); validTime(input.now);
      for (const limit of [input.maxActive,input.maxPerAccount,input.dailyLimit]) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Invalid admission limit.');
      if (!db.prepare('SELECT id FROM players WHERE id=? AND banned_at IS NULL').get(input.playerId)) throw new StoreError('STORE_FORBIDDEN','Player is unavailable.');
      const prior = db.prepare('SELECT * FROM start_receipts WHERE player_id=? AND request_id=?').get(input.playerId,input.requestId);
      if (prior) {
        if (prior.challenge_id !== input.challengeId || prior.challenge_version !== input.challengeVersion) conflict('Start request ID was already used for another challenge.');
        // A retried start can never turn a practice attempt into a sponsored one, or the reverse.
        const earlier = getAttempt(String(prior.attempt_id));
        if (earlier && earlier.mode !== (input.sponsored ? 'SPONSORED' : input.bot ? 'BOT' : 'PRACTICE')) conflict('Start request ID was already used for another mode.');
        return earlier;
      }
      // The challenge is no longer featured: an earlier accepted start may be replayed, a new one may not begin.
      if (input.replayOnly) conflict('The featured challenge has changed. Reload to see the current one.');
      const active = (playerId?: string) => Number((playerId
        ? db.prepare("SELECT count(*) AS n FROM attempts WHERE lifecycle='ACTIVE' AND player_id=?").get(playerId)
        : db.prepare("SELECT count(*) AS n FROM attempts WHERE lifecycle='ACTIVE'").get())!.n);
      if (active(input.playerId) >= input.maxPerAccount) throw new StoreError('ACTIVE_ATTEMPT_EXISTS','Resume or finish your active attempt before starting another.');
      if (active() >= input.maxActive) throw new StoreError('CAPACITY_FULL','All game slots are in use. Please try again later.');
      const day = new Date(input.now).toISOString().slice(0,10);
      const starts = Number(db.prepare('SELECT accepted FROM account_starts WHERE player_id=? AND utc_day=?').get(input.playerId,day)?.accepted ?? 0);
      if (starts >= input.dailyLimit) throw new StoreError('DAILY_LIMIT','Your daily start allowance is used. Try again after midnight UTC.');
      const created = createAttempt({...input,reconnectTokenHash:hash(randomBytes(32).toString('hex'))});
      // Refused sponsored start: nothing was created, so no receipt, quota use or notice is recorded.
      if ('refused' in created) return created;
      db.prepare('INSERT INTO start_receipts(player_id,request_id,attempt_id,challenge_id,challenge_version,created_at,opponents) VALUES(?,?,?,?,?,?,?)').run(input.playerId,input.requestId,created.id,input.challengeId,input.challengeVersion,input.now,input.sponsored ? 'LUNA' : 'HOLD');
      db.prepare('INSERT INTO account_starts(player_id,utc_day,accepted) VALUES(?,?,1) ON CONFLICT(player_id,utc_day) DO UPDATE SET accepted=accepted+1').run(input.playerId,day);
      // Same transaction as the start, so the owner notice exists exactly when the attempt does.
      new OutboxRepository(db).enqueue('ATTEMPT_STARTED',`start:${created.id}`,{attemptId:created.id,challengeId:input.challengeId,challengeVersion:input.challengeVersion,mode:created.mode,at:input.now},input.now);
      return created;
    }));
    case 'ownedAttempts': {
      const limit = input.limit ?? 30, before = input.before ?? {createdAt:Number.MAX_SAFE_INTEGER,id:''};
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 31 || typeof before.id !== 'string' || before.id.length > 100) invalid('Invalid history page.');
      validTime(before.createdAt);
      return db.prepare('SELECT * FROM attempts WHERE player_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?')
        .all(input.playerId,before.createdAt,before.createdAt,before.id,limit).map(attempt);
    }
    case 'operatorOverview': return new OperatorRepository(db).overview();
    case 'operatorAttempt': return new OperatorRepository(db).attempt(input);
    case 'setPaidStopped': return transaction(() => new OperatorRepository(db).setPaid(input));
    case 'recordOperatorAction': return transaction(() => new OperatorRepository(db).record(input));
    case 'paidState': return paidState(db);
    case 'requestCredit': return transaction(() => new OperatorRepository(db).requestCredit(input));
    case 'claimOutbox': return transaction(() => new OutboxRepository(db).claim(input));
    case 'settleOutbox': return transaction(() => new OutboxRepository(db).settle(input));
    case 'sweepRetention': return transaction(() => new RetentionRepository(db).sweep(input));
    case 'deleteAccount': return transaction(() => new RetentionRepository(db).deleteAccount(input));
    case 'latestSubmission': {
      const job = db.prepare('SELECT id,request_id FROM phase_jobs WHERE attempt_id=? AND player_id=? AND phase_id=?').get(input.attemptId,input.playerId,input.phaseId);
      if (!job) return null;
      return {receipt:getReceipt(input.attemptId,input.playerId,String(job.request_id)),action:phases().get(String(job.id))!.humanAction};
    }
    case 'touchAttempt': return transaction(() => {
      validTime(input.now);
      const current = getAttempt(input.id);
      if (!current || current.playerId !== input.playerId || !db.prepare('SELECT id FROM players WHERE id=? AND banned_at IS NULL').get(input.playerId)) throw new StoreError('STORE_FORBIDDEN','Attempt is unavailable.');
      if (current.lifecycle !== 'ACTIVE' || current.revision !== input.expectedRevision || current.lastActivityAt <= input.idleBefore) conflict('This attempt changed. Reload before continuing.');
      db.prepare('UPDATE attempts SET last_activity_at=MAX(last_activity_at,?) WHERE id=?').run(input.now,input.id);
      return getAttempt(input.id);
    });
    case 'beginPhase': return transaction(() => phases().begin(input));
    case 'phaseJob': return phases().get(input.operationId);
    case 'pendingPhaseJobs': return phases().pending();
    case 'saveDecisions': return transaction(() => phases().decisions(input));
    case 'recoverPhase': return transaction(() => phases().recover(input));
    case 'commitPhase': return transaction(() => phases().commit(input));
    case 'terminateAttempt': return transaction(() => phases().terminate(input));
    case 'health': return { schemaVersion, journalMode: String(db.prepare('PRAGMA journal_mode').get()?.journal_mode) };
    case 'identity': return transaction(() => {
      if (!['github','google'].includes(input.provider)) invalid('Unknown identity provider.');
      validText(input.subject,255); validText(input.displayName,100); validTime(input.now);
      let row = db.prepare('SELECT * FROM players WHERE provider=? AND subject=?').get(input.provider,input.subject);
      if (!row) {
        const id = randomUUID();
        db.prepare('INSERT INTO players(id,provider,subject,display_name,created_at,last_seen_at) VALUES(?,?,?,?,?,?)').run(id,input.provider,input.subject,input.displayName,input.now,input.now);
        new RetentionRepository(db).restoreStarts(id,input.provider,input.subject,input.now);
      } else db.prepare('UPDATE players SET display_name=?,last_seen_at=? WHERE id=?').run(input.displayName,input.now,row.id);
      row = db.prepare('SELECT * FROM players WHERE provider=? AND subject=?').get(input.provider,input.subject);
      return player(row!);
    });
    case 'createSession': {
      validHash(input.tokenHash); validTime(input.now); validTime(input.expiresAt);
      if (input.expiresAt > input.now + 7*24*60*60*1000 || input.expiresAt <= input.now) invalid('Session expiry exceeds the allowed lifetime.');
      const result = db.prepare('INSERT INTO sessions(token_hash,player_id,created_at,expires_at) SELECT ?,id,?,? FROM players WHERE id=? AND banned_at IS NULL').run(input.tokenHash,input.now,input.expiresAt,input.playerId);
      if (result.changes !== 1) throw new StoreError('STORE_FORBIDDEN', 'This player cannot create a session.');
      return null;
    }
    case 'session': {
      validHash(input.tokenHash); validTime(input.now);
      const row = db.prepare('SELECT p.*,s.expires_at FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL AND p.banned_at IS NULL').get(input.tokenHash,input.now);
      return row ? { player: player(row), expiresAt: Number(row.expires_at) } : null;
    }
    case 'revokeSession': validHash(input.tokenHash); validTime(input.now); db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(input.now,input.tokenHash); return null;
    case 'banPlayer': return transaction(() => {
      validTime(input.now);
      db.prepare('UPDATE players SET banned_at=? WHERE id=?').run(input.banned ? input.now : null,input.playerId);
      const sessions = input.banned ? db.prepare('SELECT token_hash FROM sessions WHERE player_id=? AND revoked_at IS NULL').all(input.playerId).map(r => String(r.token_hash)) : [];
      if (input.banned) {
        db.prepare('UPDATE sessions SET revoked_at=? WHERE player_id=?').run(input.now,input.playerId);
        for (const row of db.prepare("SELECT * FROM attempts WHERE player_id=? AND lifecycle='ACTIVE'").all(input.playerId)) {
          const active = attempt(row);
          const definition = getChallenge(active.challengeId,active.challengeVersion)!.definition;
          const score = scoreChallenge(definition,{challengeId:active.challengeId,challengeVersion:active.challengeVersion,lifecycle:'ABANDONED',reports:reports(active.id)});
          phases().cancel(active.id);
          db.prepare("UPDATE attempts SET lifecycle='STOPPED',execution='IDLE',revision=revision+1,score_json=?,updated_at=? WHERE id=?").run(canonicalJson(score),input.now,active.id);
        }
      }
      return {sessions};
    });
    case 'registerChallenge': return transaction(() => {
      const definition = parseChallenge(input.definition);
      validText(definition.id,80); validTime(input.now); validHash(input.hash);
      if (!Number.isSafeInteger(definition.version) || definition.version < 1) invalid('Invalid challenge version.');
      const board = parseBoard(input.board);
      const expectedHash = hash(canonicalJson({definition,board}));
      if (input.hash !== expectedHash) invalid('Challenge content hash mismatch.');
      const existing = getChallenge(definition.id,definition.version);
      if (existing) { if (existing.hash !== expectedHash) conflict('Challenge versions are immutable; publish a new version.'); return null; }
      db.prepare('INSERT INTO challenges(id,version,definition_json,board_json,content_hash,created_at) VALUES(?,?,?,?,?,?)').run(definition.id,definition.version,canonicalJson(definition),canonicalJson(board),expectedHash,input.now);
      return null;
    });
    case 'challenge': return getChallenge(input.id,input.version);
    case 'createAttempt': return refuseStart(transaction(() => createAttempt(input)));
    case 'attempt': {
      const result = getAttempt(input.id);
      return result && (input.playerId === undefined || result.playerId === input.playerId) ? result : null;
    }
    case 'activeAttempts': {
      const rows = db.prepare("SELECT * FROM attempts WHERE lifecycle='ACTIVE' ORDER BY created_at LIMIT 101").all();
      if (rows.length > 100) throw new StoreError('STORE_UNAVAILABLE', 'Active attempt count exceeds the supported restore bound.');
      return rows.map(attempt);
    }
    case 'receipt': return getReceipt(input.attemptId,input.playerId,input.requestId);
    case 'recordReceipt': return transaction(() => writeReceipt(input));
    case 'reports': return reports(input.attemptId);
    case 'checkpoint': return transaction(() => checkpoint(input));
    case 'backup': {
      const destination = resolve(input.destination);
      safeFile(destination,true);
      const pages = await backup(db,destination);
      chmodSync(destination,0o600);
      return {pages};
    }
    case 'close': db.close(); return null;
  }
}
let queue: Promise<unknown> = Promise.resolve();
parentPort!.on('message', (request: StoreRequest) => {
  queue = queue.then(async () => {
    try { parentPort!.postMessage({id:request.id,result:await handle(request)}); }
    catch (error) {
      const failure = error instanceof StoreError ? error
        : (error as {errcode?:number}).errcode === 5 ? new StoreError('STORE_BUSY','Persistent storage is busy. Retry shortly.')
        : new StoreError('STORE_UNAVAILABLE','Persistent storage operation failed. Inspect local health and recover before retrying an uncertain write.');
      parentPort!.postMessage({id:request.id,error:{code:failure.code,message:failure.message}});
    }
  });
});
