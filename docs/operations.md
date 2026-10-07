# Operations runbook

For whoever runs a deployment. It assumes the container layout in
[deployment.md](deployment.md). Nothing here authorizes spending, deployment or
publication; those remain owner decisions.

## Daily check

Sign in with the operator GitHub account and open **Operator** in the page
header (details in [operator.md](operator.md)).

1. **Capacity** — active attempts against the maximum. A full site answers new
   starts with "try again later"; there is no queue to drain.
2. **Budget** — available, settled, reserved and unknown liability. Reserved is
   the worst case for calls in flight and falls as they settle. Unknown
   liability is held for calls that ended without reporting usage; it stays
   until a real bill arrives and needs investigation before any budget is raised.
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

Adding money is never automatic: no timer, restart, cleanup or account action
refills anything, and the operator page cannot do it. It is a deliberate owner
action on the host, recorded permanently under a reference you choose
([funding.md](funding.md)):

```bash
npm run storage -- funding /data/diplomacy.sqlite
npm run storage -- grant /data/diplomacy.sqlite <USD> <authorization-reference>
```

Read the budget figures first. If **unknown liability** is above zero, find out
what those calls cost before granting more. After a grant, press **Resume paid
calls** if the pool had run out. `LLM_TOTAL_BUDGET_USD` only narrows what grants
allow. Paid play itself is still switched off in code until the provider adapter
is integrated and the owner authorizes spend.

## Turning on live Luna opponents (not done; owner decision)

Today a deployment offers practice only. Everything below is deliberate work
that has **not** been done, in the order it should happen:

1. **Live evaluation.** A first live attempt of the sequential preset was run on
   October 7, 2026 and missed two of the three targets
   ([evaluation.md](evaluation.md)). The concurrent preset that followed has not
   been measured live. On the machine that holds the ledger database, run a
   small live batch under a new run ID against the same funded ledger; record a
   further grant only if the owner authorizes more spend. Read the report
   against the three targets.
2. **Decide.** If the targets are missed, stop here. Do not relax them quietly.
3. **Remove the two code interlocks in one reviewed change**: the refusal in
   `assertRuntimeReady` (`config/runtime.cjs`) and the matching check at the top
   of `ChallengeService`'s constructor, and in that same change construct
   `httpLunaTransport` from `OPENAI_API_KEY` when `DIPLOMACY_PAID_AI_ENABLED` is
   true. Nothing else selects the real transport. Update `RuntimeConfig.test.ts`,
   `scripts/staging-check.sh` (it asserts the refusal) and `AccessMatrix.test.ts`
   if a route changes.
4. **Configure** `DIPLOMACY_PAID_AI_ENABLED=true`, `LLM_ALLOWED_PROVIDERS=OPENAI`,
   `OPENAI_API_KEY`, `LLM_TOTAL_BUDGET_USD` (a brake, not a source of funds) and
   `LLM_MAX_GAME_COST_USD` (the per-attempt cap), plus the operator ID and both
   sign-in providers, which paid showcase mode requires.
5. **Grant** funds in the production database and check `storage funding`.
6. **Watch** the operator view during the first attempts; **Stop new paid
   calls** is immediate.

Until step 3 the server refuses to start with paid AI enabled, whatever the
environment says.

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
window. Provider call records go after the receipt window once their cost is
settled or released; a call that might still be billed is kept however old. Players delete their own accounts from the page;
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
