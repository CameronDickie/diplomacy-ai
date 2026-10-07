# Operations runbook

For whoever runs a deployment. It assumes the container layout in
[deployment.md](deployment.md). Nothing here authorizes spending, deployment or
publication; those remain owner decisions.

## Daily check

Sign in with the operator GitHub account and open **Operator** in the page
header (details in [operator.md](operator.md)).

1. **Capacity** — active attempts against the maximum. A full site answers new
   starts with "try again later"; there is no queue to drain.
2. **Spend** — known cost and unresolved liability. Unresolved liability is the
   worst case for calls whose bill has not arrived; it should fall to zero once
   in-flight work settles. A value that stays above zero means a provider call
   never reported usage and needs investigation before any budget is raised.
3. **Notifications** — anything `FAILED` was abandoned after eight tries.
4. **Attempts** — stuck `RECOVERING` rows are covered under "After a crash".

## Stop paid play

Operator → **Stop new paid calls** → confirm. From that moment every provider
`prepare` and `dispatch` is refused, including queued and recovered work. Calls
already in flight may still bill, and their usage is still recorded. The public
page shows sponsored play as paused, and each account may send one request to
the owner per pause. **Resume paid calls** reverses it. The switch survives
restarts.

Stopping never changes a budget, and resuming never adds one.

## Replenishment

Adding money is not an operator-panel action and never happens automatically:
no timer, restart, cleanup or account action refills anything. It is a
deliberate owner change to the funded total in private configuration followed by
a restart, after reading the spend figures above. The reservation ledger that
enforces the total is not merged yet (DIC-64); until it is, the server refuses
to start with `DIPLOMACY_PAID_AI_ENABLED=true`, so there is nothing to
replenish. This section will gain the exact procedure with that change.

## Stop an attempt or ban an account

Operator → the attempt's row → **Stop** or **Ban account**, then confirm. Stop
closes that attempt as `STOPPED` and the player keeps its saved result. Ban
revokes the account's sessions, disconnects it, stops its active attempts and
blocks new sign-in sessions until **Unban**. A banned account cannot delete
itself. Every action is in "Recent operator actions".

## Capacity and limits

Change these in the environment file and restart; they are validated at startup
([configuration.md](configuration.md), [limits.md](limits.md)).

```dotenv
DIPLOMACY_MAX_ACTIVE_ATTEMPTS=3
DIPLOMACY_MAX_ACTIVE_PER_ACCOUNT=1
DIPLOMACY_DAILY_START_LIMIT=3
DIPLOMACY_IDLE_WARN_MINUTES=25
DIPLOMACY_IDLE_EXPIRE_MINUTES=30
```

Lowering a limit does not end attempts already running. Behind your own reverse
proxy set `DIPLOMACY_TRUSTED_PROXY=private`; otherwise leave it `none`.

## Retention and deletion

```dotenv
DIPLOMACY_RESULT_RETENTION_DAYS=30
DIPLOMACY_DIAGNOSTIC_RETENTION_DAYS=7
DIPLOMACY_RECEIPT_RETENTION_DAYS=90
```

Cleanup runs at startup and hourly ([storage.md](storage.md)). Closed attempts
go after the result window; their phase jobs and receipts after the diagnostic
window. Provider call records are not pruned yet, so the 90-day setting has no
effect until the ledger lands. Players delete their own accounts from the page;
there is no operator "delete user" control, and deletion keeps anonymous cost
records.

## Notifications

```dotenv
DIPLOMACY_NOTIFY_MODE=outbox
# For real email, all three are required and validated:
# DIPLOMACY_NOTIFY_MODE=resend
# RESEND_API_KEY=<private>
# DIPLOMACY_NOTIFY_FROM=Game <notifications@your-verified-domain.example>
# DIPLOMACY_NOTIFY_TO=owner@example.com
```

In `outbox` mode nothing is sent and messages are read in the operator view.
Messages contain attempt, scenario and anonymous account identifiers only.

## Backup, restore and rollback

Take backups with the storage command, never by copying the live file:

```bash
npm run storage -- backup /data/diplomacy.sqlite /backups/diplomacy-$(date -u +%Y%m%dT%H%M%SZ).sqlite
```

Restore into a **new** path with the server stopped, then point
`DIPLOMACY_DATABASE_PATH` at it. A restore verifies integrity, foreign keys and
migration history first. Migrations only move forward: to roll back the
application, restore the backup taken before the upgrade together with the
matching image. Never start an older image against a newer database; it refuses
with a schema error. Spend records and unresolved liabilities are part of the
database and travel with the backup. Full detail is in [storage.md](storage.md).

## After a crash or restart

Startup re-reads every active attempt and resumes interrupted phases from their
frozen inputs; nothing is replayed from the browser. An attempt left in
`RECOVERING` shows the player a "Recover saved phase" button. Sessions, bans,
quotas, the paid switch and queued notifications are durable. Short-window rate
buckets and in-progress sign-in flows are memory only and reset.

If `GET /healthz` reports storage unavailable, stop the server, keep the
database and its `-wal` and `-shm` files together, and restore from the latest
backup if integrity checks fail on restart.

## Changing the scenarios

The rotation is `server/fixtures/rotation/development.v1.json`
([first-challenge.md](first-challenge.md)). Shipped scenario versions are
immutable: publish a changed board or objective as a new scenario version and a
new manifest version. Validate before deploying:

```bash
npm run fixture -- validate server/fixtures/development/<scenario>.v<version>.json
npm run fixture -- play server/fixtures/development/<scenario>.v<version>.json early-capture /tmp/after.json
```

Replacing the development rotation with a public daily catalog is an owner
approval, not a configuration switch.
