import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { StoreError } from './contracts.js';

// Append migrations; never edit a migration already shipped to a database.
const migrations = [{ version: 1, sql: `
CREATE TABLE players (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('github','google')),
 subject TEXT NOT NULL, display_name TEXT NOT NULL, created_at INTEGER NOT NULL,
 last_seen_at INTEGER NOT NULL, banned_at INTEGER,
 UNIQUE(provider,subject)
) STRICT;
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
 player_id TEXT NOT NULL REFERENCES players(id), created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at), revoked_at INTEGER
) STRICT;
CREATE INDEX sessions_player ON sessions(player_id);
CREATE TABLE challenges (
 id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 board_json TEXT NOT NULL CHECK(json_valid(board_json)),
 content_hash TEXT NOT NULL CHECK(length(content_hash)=64), created_at INTEGER NOT NULL,
 PRIMARY KEY(id,version)
) STRICT;
CREATE TRIGGER challenges_immutable BEFORE UPDATE ON challenges BEGIN
 SELECT RAISE(ABORT,'immutable challenge version'); END;
CREATE TABLE attempts (
 id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id),
 challenge_id TEXT NOT NULL, challenge_version INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), phase_id TEXT NOT NULL,
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('ACTIVE','COMPLETED','ABANDONED','EXPIRED','STOPPED')),
 execution TEXT NOT NULL CHECK(execution IN ('ACCEPTING','DECIDING','RESOLVING','RECOVERING','IDLE')),
 board_json TEXT NOT NULL CHECK(json_valid(board_json)),
 score_json TEXT CHECK(score_json IS NULL OR json_valid(score_json)),
 reconnect_token_hash TEXT NOT NULL CHECK(length(reconnect_token_hash)=64),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
 FOREIGN KEY(challenge_id,challenge_version) REFERENCES challenges(id,version)
) STRICT;
CREATE INDEX attempts_owner ON attempts(player_id,created_at);
CREATE INDEX attempts_active ON attempts(lifecycle,last_activity_at);
CREATE TABLE reports (
 attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(sequence>0), report_json TEXT NOT NULL CHECK(json_valid(report_json)),
 PRIMARY KEY(attempt_id,sequence)
) STRICT;
CREATE TABLE receipts (
 attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
 player_id TEXT NOT NULL REFERENCES players(id), request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 state_json TEXT NOT NULL CHECK(json_valid(state_json)), created_at INTEGER NOT NULL,
 PRIMARY KEY(attempt_id,player_id,request_id)
) STRICT;
` }, { version: 2, sql: `
CREATE TABLE phase_jobs (
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
 phase_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0),
 status TEXT NOT NULL CHECK(status IN ('DECIDING','RESOLVING','RECOVERING','COMMITTED','CANCELLED')),
 player_id TEXT NOT NULL REFERENCES players(id), request_id TEXT NOT NULL,
 board_json TEXT NOT NULL CHECK(json_valid(board_json)),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 human_action_json TEXT NOT NULL CHECK(json_valid(human_action_json)),
 decisions_json TEXT CHECK(decisions_json IS NULL OR json_valid(decisions_json)),
 report_offset INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(attempt_id,phase_id),
 UNIQUE(attempt_id,player_id,request_id)
) STRICT;
CREATE INDEX phase_jobs_pending ON phase_jobs(status);
CREATE TRIGGER phase_inputs_immutable BEFORE UPDATE OF attempt_id,phase_id,player_id,request_id,board_json,definition_json,human_action_json,report_offset,created_at ON phase_jobs BEGIN
 SELECT RAISE(ABORT,'immutable phase input'); END;
` }, { version: 3, sql: `
ALTER TABLE attempts ADD COLUMN mode TEXT NOT NULL DEFAULT 'PRACTICE' CHECK(mode IN ('PRACTICE'));
CREATE TABLE start_receipts (
 player_id TEXT NOT NULL REFERENCES players(id), request_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL REFERENCES attempts(id), challenge_id TEXT NOT NULL,
 challenge_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(player_id,request_id)
) STRICT;
CREATE TABLE account_starts (
 player_id TEXT NOT NULL REFERENCES players(id), utc_day TEXT NOT NULL,
 accepted INTEGER NOT NULL CHECK(accepted>=0), PRIMARY KEY(player_id,utc_day)
) STRICT;
` }, { version: 4, sql: `
CREATE TABLE provider_calls (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
 intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
 state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHED','RECEIVED','FINISHED')),
 created_at INTEGER NOT NULL, dispatched_at INTEGER, received_at INTEGER, finished_at INTEGER,
 response_id TEXT, usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('VALID','INVALID_JSON','INVALID_ACTION','REFUSED','INCOMPLETE','PROVIDER_ERROR','TRANSPORT_ERROR','TIMEOUT','CANCELLED'))
) STRICT;
CREATE INDEX provider_calls_operation ON provider_calls(operation_id);
CREATE INDEX provider_calls_attempt ON provider_calls(attempt_id);
CREATE UNIQUE INDEX provider_calls_response ON provider_calls(response_id) WHERE response_id IS NOT NULL;
CREATE TRIGGER provider_intent_immutable BEFORE UPDATE OF id,operation_id,attempt_id,intent_json,created_at ON provider_calls BEGIN
 SELECT RAISE(ABORT,'immutable provider intent'); END;
` }, { version: 5, sql: `
CREATE TABLE deleted_identities (
 identity_hash TEXT PRIMARY KEY CHECK(length(identity_hash)=64), utc_day TEXT NOT NULL,
 accepted INTEGER NOT NULL CHECK(accepted>0), deleted_at INTEGER NOT NULL
) STRICT;
` }, { version: 6, sql: `
CREATE TABLE operator_state (
 key TEXT PRIMARY KEY, value_json TEXT NOT NULL CHECK(json_valid(value_json)), updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE operator_audit (
 id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operator_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT
) STRICT;
CREATE TABLE outbox (
 id INTEGER PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('ATTEMPT_STARTED','CREDIT_REQUEST')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 state TEXT NOT NULL CHECK(state IN ('PENDING','SENDING','SENT','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, sent_at INTEGER, channel TEXT CHECK(channel IS NULL OR channel IN ('outbox','resend')), last_error TEXT
) STRICT;
CREATE INDEX outbox_due ON outbox(state,next_attempt_at);
` }, { version: 7, sql: `
CREATE TABLE funding_grants (
 authorization_ref TEXT PRIMARY KEY CHECK(length(authorization_ref) BETWEEN 8 AND 100),
 amount_nanousd INTEGER NOT NULL CHECK(amount_nanousd>0), granted_at INTEGER NOT NULL, granted_by TEXT NOT NULL
) STRICT;
CREATE TRIGGER funding_grants_immutable BEFORE UPDATE ON funding_grants BEGIN
 SELECT RAISE(ABORT,'immutable funding grant'); END;
CREATE TRIGGER funding_grants_permanent BEFORE DELETE ON funding_grants BEGIN
 SELECT RAISE(ABORT,'funding grants are permanent'); END;
CREATE TABLE funding_pool (
 id INTEGER PRIMARY KEY CHECK(id=1),
 settled_nanousd INTEGER NOT NULL DEFAULT 0 CHECK(settled_nanousd>=0),
 attempt_cap_nanousd INTEGER NOT NULL CHECK(attempt_cap_nanousd BETWEEN 1 AND 15000000000),
 ceiling_limit_nanousd INTEGER CHECK(ceiling_limit_nanousd IS NULL OR ceiling_limit_nanousd>=0),
 updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO funding_pool(id,attempt_cap_nanousd,updated_at) VALUES(1,1000000000,0);
CREATE TRIGGER funding_pool_permanent BEFORE DELETE ON funding_pool BEGIN
 SELECT RAISE(ABORT,'the funding pool is permanent'); END;
CREATE TRIGGER funding_pool_monotonic BEFORE UPDATE OF settled_nanousd ON funding_pool WHEN NEW.settled_nanousd<OLD.settled_nanousd BEGIN
 SELECT RAISE(ABORT,'settled spend never decreases'); END;
CREATE TABLE reservations (
 call_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL,
 reserved_nanousd INTEGER NOT NULL CHECK(reserved_nanousd>0),
 state TEXT NOT NULL CHECK(state IN ('HELD','SETTLED','RELEASED')),
 settled_nanousd INTEGER CHECK((state='SETTLED')=(settled_nanousd IS NOT NULL)),
 created_at INTEGER NOT NULL, closed_at INTEGER
) STRICT;
CREATE INDEX reservations_held ON reservations(state,attempt_id);
CREATE TRIGGER reservations_final BEFORE UPDATE ON reservations WHEN OLD.state<>'HELD' BEGIN
 SELECT RAISE(ABORT,'a closed reservation is final'); END;
CREATE TRIGGER reservations_held_permanent BEFORE DELETE ON reservations WHEN OLD.state='HELD' BEGIN
 SELECT RAISE(ABORT,'a held reservation cannot be deleted'); END;
CREATE TABLE attempt_spend (
 attempt_id TEXT PRIMARY KEY, settled_nanousd INTEGER NOT NULL DEFAULT 0 CHECK(settled_nanousd>=0),
 calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0)
) STRICT;
` }, { version: 8, sql: `
CREATE TABLE provider_decisions (
 call_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES phase_jobs(id) ON DELETE CASCADE,
 power TEXT NOT NULL, action_json TEXT NOT NULL CHECK(json_valid(action_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX provider_decisions_operation ON provider_decisions(operation_id);
CREATE TRIGGER provider_decisions_immutable BEFORE UPDATE ON provider_decisions BEGIN
 SELECT RAISE(ABORT,'immutable provider decision'); END;
` }, { version: 9, sql: `
ALTER TABLE attempts ADD COLUMN opponents TEXT NOT NULL DEFAULT 'HOLD' CHECK(opponents IN ('HOLD','LUNA'));
ALTER TABLE attempts ADD COLUMN preset_id TEXT;
ALTER TABLE attempts ADD COLUMN pricing_version TEXT;
ALTER TABLE start_receipts ADD COLUMN opponents TEXT NOT NULL DEFAULT 'HOLD';
CREATE TRIGGER attempts_mode_immutable BEFORE UPDATE OF mode,opponents,preset_id,pricing_version ON attempts BEGIN
 SELECT RAISE(ABORT,'immutable attempt mode'); END;
` }, { version: 10, sql: `
ALTER TABLE attempts ADD COLUMN practice_bot INTEGER NOT NULL DEFAULT 0 CHECK(practice_bot IN (0,1) AND (practice_bot=0 OR opponents='HOLD'));
CREATE TRIGGER attempts_bot_immutable BEFORE UPDATE OF practice_bot ON attempts BEGIN
 SELECT RAISE(ABORT,'immutable attempt mode'); END;
` }, { version: 11, sql: `
CREATE TABLE exhibitions (
 id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, challenge_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('RUNNING','PAUSED','COMPLETED','STALLED','CANCELLED','FAILED')),
 reason TEXT, board_json TEXT NOT NULL CHECK(json_valid(board_json)),
 phases INTEGER NOT NULL DEFAULT 0 CHECK(phases>=0), max_phases INTEGER NOT NULL CHECK(max_phases BETWEEN 1 AND 200),
 quiet_phases INTEGER NOT NULL DEFAULT 0 CHECK(quiet_phases>=0),
 recent_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(recent_json)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT NOT NULL,
 FOREIGN KEY(challenge_id,challenge_version) REFERENCES challenges(id,version)
) STRICT;
CREATE INDEX exhibitions_state ON exhibitions(state,created_at);
CREATE TABLE exhibition_reports (
 exhibition_id TEXT NOT NULL REFERENCES exhibitions(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(sequence>0), report_json TEXT NOT NULL CHECK(json_valid(report_json)),
 PRIMARY KEY(exhibition_id,sequence)
) STRICT;
` }, { version: 12, sql: `
CREATE TABLE funding_adjustments (
 call_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL,
 credited_nanousd INTEGER NOT NULL CHECK(credited_nanousd>=0),
 actual_nanousd INTEGER NOT NULL CHECK(actual_nanousd>=0),
 delta_nanousd INTEGER NOT NULL CHECK(delta_nanousd=max(0,actual_nanousd-credited_nanousd)),
 recorded_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER funding_adjustments_immutable BEFORE UPDATE ON funding_adjustments BEGIN
 SELECT RAISE(ABORT,'immutable billing correction'); END;
CREATE TRIGGER funding_adjustments_permanent BEFORE DELETE ON funding_adjustments BEGIN
 SELECT RAISE(ABORT,'billing correction evidence is permanent'); END;
` }, { version: 13, sql: `
CREATE TABLE evaluation_runs (
 id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE evaluation_attempts (
 attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES evaluation_runs(id), ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 200),
 created_at INTEGER NOT NULL, UNIQUE(run_id,ordinal)
) STRICT;
CREATE TABLE evaluation_phases (
 operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES evaluation_attempts(attempt_id), phase_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0), started_at INTEGER NOT NULL CHECK(started_at>=0),
 completed_at INTEGER CHECK(completed_at>=0), duration_ms INTEGER CHECK(duration_ms>=0), recoveries INTEGER NOT NULL DEFAULT 0 CHECK(recoveries>=0),
 UNIQUE(attempt_id,sequence), CHECK(completed_at IS NOT NULL OR duration_ms IS NULL)
) STRICT;
CREATE TRIGGER evaluation_runs_permanent BEFORE DELETE ON evaluation_runs BEGIN SELECT RAISE(ABORT,'evaluation manifest is permanent'); END;
CREATE TRIGGER evaluation_attempts_permanent BEFORE DELETE ON evaluation_attempts BEGIN SELECT RAISE(ABORT,'evaluation attempt identity is permanent'); END;
CREATE TRIGGER evaluation_phases_permanent BEFORE DELETE ON evaluation_phases BEGIN SELECT RAISE(ABORT,'phase timing evidence is permanent'); END;
CREATE TRIGGER evaluation_runs_immutable BEFORE UPDATE ON evaluation_runs BEGIN SELECT RAISE(ABORT,'immutable evaluation manifest'); END;
CREATE TRIGGER evaluation_attempts_immutable BEFORE UPDATE ON evaluation_attempts BEGIN SELECT RAISE(ABORT,'immutable evaluation attempt'); END;
CREATE TRIGGER evaluation_phases_identity BEFORE UPDATE ON evaluation_phases
 WHEN OLD.operation_id<>NEW.operation_id OR OLD.attempt_id<>NEW.attempt_id OR OLD.phase_id<>NEW.phase_id
 OR OLD.sequence<>NEW.sequence OR OLD.started_at<>NEW.started_at
 BEGIN SELECT RAISE(ABORT,'immutable phase timing identity'); END;
CREATE TRIGGER evaluation_phases_completed BEFORE UPDATE ON evaluation_phases WHEN OLD.completed_at IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'immutable completed phase timing'); END;
` }, { version: 14, sql: `
CREATE TABLE chat_messages (
 id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
 power TEXT NOT NULL, sender TEXT NOT NULL CHECK(sender IN ('PLAYER','OPPONENT')),
 request_id TEXT, body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
 reply_state TEXT CHECK(reply_state IN ('PENDING','COMPLETE','FAILED')),
 phase_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
 CHECK((sender='PLAYER')=(request_id IS NOT NULL)), CHECK((sender='PLAYER')=(reply_state IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX chat_messages_request ON chat_messages(attempt_id,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX chat_messages_attempt ON chat_messages(attempt_id,created_at);
CREATE TRIGGER chat_messages_content BEFORE UPDATE ON chat_messages
 WHEN OLD.id<>NEW.id OR OLD.attempt_id<>NEW.attempt_id OR OLD.power<>NEW.power OR OLD.sender<>NEW.sender OR OLD.body<>NEW.body OR OLD.created_at<>NEW.created_at
 BEGIN SELECT RAISE(ABORT,'immutable chat message'); END;
` }, { version: 15, sql: `
CREATE TABLE power_talks (
 call_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, phase_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('ASK','REPLY')), power TEXT NOT NULL,
 messages_json TEXT NOT NULL CHECK(json_valid(messages_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX power_talks_attempt ON power_talks(attempt_id,created_at);
CREATE TRIGGER power_talks_immutable BEFORE UPDATE ON power_talks BEGIN SELECT RAISE(ABORT,'immutable power talk'); END;
` }, { version: 16, sql: `
CREATE TABLE power_notes (
 call_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
 phase_id TEXT NOT NULL, power TEXT NOT NULL,
 note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 400), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX power_notes_attempt ON power_notes(attempt_id,created_at);
CREATE TRIGGER power_notes_immutable BEFORE UPDATE ON power_notes BEGIN SELECT RAISE(ABORT,'immutable power note'); END;
` }, { version: 17, sql: `
ALTER TABLE funding_grants ADD COLUMN provider TEXT CHECK(provider IS NULL OR provider IN ('OPENAI','ANTHROPIC'));
` }, { version: 18, sql: `
CREATE TABLE human_actions (
 operation_id TEXT NOT NULL REFERENCES phase_jobs(id) ON DELETE CASCADE,
 power TEXT NOT NULL, action_json TEXT NOT NULL CHECK(json_valid(action_json)),
 created_at INTEGER NOT NULL, PRIMARY KEY(operation_id,power)
) STRICT;
CREATE TRIGGER human_actions_immutable BEFORE UPDATE ON human_actions BEGIN SELECT RAISE(ABORT,'immutable human action'); END;
` }, { version: 19, sql: `
CREATE TABLE autoplay_settings (
 attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
 settings_json TEXT NOT NULL CHECK(json_valid(settings_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER autoplay_settings_immutable BEFORE UPDATE ON autoplay_settings BEGIN SELECT RAISE(ABORT,'immutable autoplay settings'); END;
` }];

export function verifyMigrationHistory(db: DatabaseSync, requireExisting = false): number {
  if (requireExisting && !db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get()) {
    throw new StoreError('STORE_SCHEMA', 'Backup is not a migrated Diplomacy database.');
  }
  const applied = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
  if (db.prepare('PRAGMA user_version').get()?.user_version !== applied.length) throw new StoreError('STORE_SCHEMA', 'Database schema version is inconsistent.');
  if (requireExisting && applied.length === 0) throw new StoreError('STORE_SCHEMA', 'Backup has no completed migrations.');
  for (const [i, row] of applied.entries()) {
    const migration = migrations[i];
    if (!migration || row.version !== migration.version || row.checksum !== digest(migration.sql)) {
      throw new StoreError('STORE_SCHEMA', 'Database migration history does not match this server. Restore a compatible build.');
    }
  }
  return applied.length;
}

export function migrate(db: DatabaseSync): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT');
    const applied = verifyMigrationHistory(db);
    for (const migration of migrations.slice(applied)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version,checksum) VALUES(?,?)').run(migration.version,digest(migration.sql));
    }
    db.exec(`PRAGMA user_version=${migrations.length}`);
    db.exec('COMMIT');
    return migrations.length;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
const digest = (sql: string) => createHash('sha256').update(sql).digest('hex');
