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
