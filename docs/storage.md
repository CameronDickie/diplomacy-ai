# Durable storage foundation

The server opens the configured SQLite database before listening. Its health
endpoint returns 503 when the repository cannot respond. New databases use
versioned, checksum-checked migrations; an unknown or modified migration history
fails startup. There is no fallback to an empty in-memory database.

The repository currently stores stable provider identities, hashed revocable
sessions, immutable challenge versions, rules-only attempt snapshots, public
phase reports, idempotent submission receipts and frozen phase jobs. The
[attempt coordinator](attempts.md) now commits and recovers those phase jobs,
including real process-kill tests. Owned offline challenge admission and browser
resume now use this repository, including durable start receipts and UTC start
counters. Provider call records, atomic reservations, cumulative spending,
unknown liabilities, operator/outbox state, retention and exhibitions also use
the repository. Private evaluation manifests and phase timing/recovery evidence
are durable; see [evaluation.md](evaluation.md). Legacy rooms remain in memory.
Paid startup is still interlocked.

## Chat messages

`chat_messages` (migration 14) holds the player's private conversations with
opponent powers, per attempt. Rows cascade from the attempt, so retention and
account deletion remove them. A player's message is unique per attempt and
request id; content is immutable; only its reply state changes. The feature
that writes them is development only ([playtest.md](playtest.md)).

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
700. Database symlinks and non-regular files are rejected. Application sessions use keyed HMAC-SHA256 digests; reconnect
secrets use SHA-256 digests. Public report projections omit
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
Keep the backup file on a writable filesystem when restoring: it is a WAL-mode
database and SQLite cannot open it from read-only media.

To recover a deployment, stop the application, restore into a new path, verify
health and the expected records, then point the stopped deployment at that
path. Preserve the old database and WAL files for investigation. Starting an
older image against a newer schema intentionally fails; use a compatible
backup when rolling back. Do not delete budget evidence or reinterpret a
restored total as a refill. The financial ledger is already integrated;
restored spend and held liabilities consume the same funding authorization.

Tests exercise restart, identity separation, session expiration/revocation/ban,
receipt replay, atomic rollback, pinned definitions, terminal-state protection,
backup/restore, migration mismatch, private-field projection and lock contention
with responsive HTTP. Login has HTTP/socket and real-provider browser evidence.
Phase recovery has coordinator/process-crash evidence. The offline browser
attempt survives API restart and completes with saved results/replay. Spend
reservations, funded recovery and retention have offline crash/accounting
tests, including deletion and late bills. Local container staging verifies
unchanged settled spend and held liability through backup, restart and restore.
These checks do not establish live model quality or authorize production release.

Private evaluation aggregate records and immutable billing corrections remain
after raw attempts or settled receipt details expire. They carry no raw boards,
chat, reasoning or credentials, and cannot recreate funding or expired attempts.

## Retention and account deletion

`sweepRetention` runs from the challenge sweep at startup and then at most
hourly, in bounded batches inside one transaction each. Ages are measured from
the write that closed the attempt; an `ACTIVE` attempt is never removed.

| Data | Kept for | Removed |
| -- | -- | -- |
| Closed attempt, board, score, reports | `DIPLOMACY_RESULT_RETENTION_DAYS` (30) | attempt row and everything cascading from it, plus its start receipt |
| Phase jobs (frozen inputs, opponent decisions) and submission receipts | `DIPLOMACY_DIAGNOSTIC_RETENTION_DAYS` (7) | per closed attempt; the result stays readable |
| Expired or revoked sessions | diagnostic window after expiry/revocation | session rows |
| Daily start counters, deleted-identity markers | until their UTC day has passed | rows for earlier days |
| `provider_calls`, closed reservations | `DIPLOMACY_RECEIPT_RETENTION_DAYS` (90) after the reservation closed | settled or released calls only; a held reservation and its call are never pruned |

`provider_calls` has no owner column and no foreign key to attempts, so it
survives both cleanup and account deletion as pseudonymous evidence, and a late
bill still reconciles against it. Cumulative settled spend and per-attempt totals live in
the funding ledger ([funding.md](funding.md)), so pruning an old settled receipt
changes no total and can never act as a refill.

`POST /api/account/delete` with `{"confirm":"DELETE"}` removes the player,
sessions, attempts (in progress or saved), reports, receipts, phase jobs and
start counters in one transaction, then aborts that player's in-flight work and
drops its live sockets. Afterwards the fence checks in `prepareProviderCall` /
`dispatchProviderCall` reject, so no new paid job can begin for the removed
attempt. Two rules prevent deletion being used as a workaround:

- Today's accepted starts are kept under `sha256(provider:subject)` in
  `deleted_identities` and restored if the same identity signs in again the same
  UTC day. The marker is removed once that day has passed.
- A banned identity cannot be deleted, so a ban outlives its account.

Owned history is paged: `GET /api/attempts` returns 20 attempts and a `next`
cursor for `?before=`.
