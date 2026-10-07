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
