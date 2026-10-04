# Durable storage foundation

The server opens the configured SQLite database before listening. Its health
endpoint returns 503 when the repository cannot respond. New databases use
versioned, checksum-checked migrations; an unknown or modified migration history
fails startup. There is no fallback to an empty in-memory database.

The repository currently stores stable provider identities, hashed revocable
sessions, immutable challenge versions, rules-only attempt snapshots, public
phase reports and idempotent submission receipts. It can reopen these records
and perform revision-checked atomic checkpoints. It does **not yet connect the
legacy room flow to durable challenge admission or phase recovery**. DIC-51 and
DIC-60 integrate those boundaries. DIC-59 stays open until the actual challenge
flow survives a server restart. Provider accounting/reservations and retention
cleanup remain separate work; paid startup is still disabled by its interlock.

## Runtime and files

Node.js 22.16+ is required for the built-in SQLite backup API, which is marked
experimental in Node 22. CI covers Node 22 and 26 using their common documented
API subset. The database runs in one worker per server, keeping synchronous
SQLite calls and lock waits off
the HTTP event loop. The worker has no inherited provider environment and
accepts named operations, not arbitrary SQL. Its queue allows at most 64 pending
requests of at most 2 MiB each. Database lock waits are 250 ms; queue-inclusive
RPC deadlines are 10 seconds (60 for backup). A timed-out write is uncertain:
the repository fails closed, and callers must reopen/read committed state
before deciding what to retry. It never automatically replays a mutation.
See the [Node SQLite API](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html).

SQLite uses WAL, foreign keys, FULL synchronous durability and bound query
parameters. Database/backup files are mode 600; newly created directories are
700. Database symlinks and non-regular files are rejected. Session/reconnect
secrets are stored only as SHA-256 digests. Public report projections omit
extra session/chat/provider fields. Backups still contain private account and
session-hash data: keep them private, outside the repository and image context.
SQLite files and data directories are excluded from Git and Docker builds.

Local default: `data/diplomacy.sqlite` beneath the project root. Production
default: `/data/diplomacy.sqlite`, matching the Compose `/data` mount. The image
uses UID/GID 10001, and new Terraform hosts assign the data directory to that
user. For an existing Linux deployment, prepare the bind-mount directory before
starting the new image, substituting the actual app directory:

```sh
sudo chown 10001:10001 /opt/diplomacy/data
sudo chmod 700 /opt/diplomacy/data
```

Do not apply this to the environment-file directory. A permission failure is an
explicit startup failure; do not work around it by running the app as root or
making the database world-readable.

## Backup and restore

After `npm run build`, local operator commands are:

```sh
npm run storage -- init /absolute/path/new-game.sqlite
npm run storage -- health /absolute/path/game.sqlite
npm run storage -- backup /absolute/path/game.sqlite /private/backups/game-new.sqlite
npm run storage -- restore /private/backups/game-new.sqlite /private/restored/game.sqlite
```

Only `init` creates a missing source database; other commands reject a missing
source rather than treating a mistyped path as an empty installation. These
commands do not load `.env`. Paths are explicit. Health/backup open their source
read-only and do not migrate it before taking a backup. Backup uses SQLite's online backup API,
not a copy of the main file while WAL writes are pending. Backup and restore
refuse to overwrite an existing destination. Restore checks database integrity
and migration compatibility. A failed restore can leave its newly created
private destination for inspection; choose another new path for a retry.

To recover a deployment, stop the application, restore into a new path, verify
health and the expected records, then point the stopped deployment at that
path. Preserve the old database and WAL files for investigation. Starting an
older image against a newer schema intentionally fails; use a compatible
backup when rolling back. Do not delete budget evidence or reinterpret a
restored total as a refill when the financial ledger is integrated.

Tests exercise restart, identity separation, session expiration/revocation/ban,
receipt replay, atomic rollback, pinned definitions, terminal-state protection,
backup/restore, migration mismatch, private-field projection and lock contention
with responsive HTTP. Public login, attempt recovery, spend reservations and
retention require their own integration evidence before release.
