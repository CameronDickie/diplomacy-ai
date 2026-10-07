# Durable phase execution

`server/src/attempts/AttemptService.ts` coordinates one human submission and six
opponents from a fixed, versioned challenge. It uses the SQLite worker and
bounded Godip executor. Its offline decision adapter holds, disbands retreats
and waives builds (or removes the required units deterministically). This is a
test policy, not the public Luna opponent.

The server starts the challenge service before listening and recovers pending
jobs against its configured SQLite database. Showcase renders the challenge UI;
local/private deployments can open `/challenge` while retaining their legacy
lobby at `/`. Legacy room sockets remain disabled in showcase. This intermediate
flow is explicitly **offline practice**, not a funded or publicly released daily
challenge. Paid dispatch remains interlocked; phase jobs are not financial
reservations.

## Owned practice flow

Public `GET /api/challenges` and `/api/challenges/demo` expose the scenario
featured for the current UTC day (see "Development rotation" in
`docs/first-challenge.md`) and its offline reference replay. The catalog also publishes the enforced
start/idle limits plus live `capacity` and `sponsoredPlay` availability (see
`docs/operator.md`), which the visitor guide renders instead of hard-coded numbers. The replay is tagged `kind: "REFERENCE"`,
passes through `publicReplay` (explicit fields, stable `reference-N` IDs and a
fixed timestamp) and is identical across restarts; neither route touches the
store, sessions or a provider. Authenticated players start with
`POST /api/attempts`, supplying only the catalog ID/version and a request ID.
The server rejects model, board, budget and other payload overrides. A single
transaction checks ban, three-global/one-account active limits, three accepted
starts per UTC day, and duplicate receipts. Retry after uncertain delivery uses
the same request ID. Accepted starts remain counted after abandonment/restart.

`GET /api/attempts` lists the player's latest 30 attempts. Owned attempt routes
provide the board, phase reports and a revision-fenced human legal catalog;
orders, explicit activity, abandonment and recovery use protected POSTs.
Every request checks authentication and ownership; catalog choices never include
another power's units. Godip supplies move/support/convoy/coast choices, including
friendly destinations and cooperative allied actions. A legal choice is not a
promise that the move succeeds.

Polling does not refresh activity. Selecting a unit, changing a choice, accepting
a new submission or pressing “I'm still here” does. Warn at 25 idle minutes and
expire at 30; mutation-time idle checks and a ten-second sweep close stale work.
An activity update racing a sweep cannot revive an expired attempt or expire a
recently active one. Login, the active board and completed results survive API
restart. Logout clears private client state.

Development catalog rotation and the funded Luna preset remain follow-up work.
No owner-approved public catalog is implied by these fixtures.

## Authority and state transitions

A command supplies an attempt, expected revision, phase ID, request ID and strict
phase choices. Movement choices are legal catalog IDs, one per unit. Retreats
and builds use the existing rules validation, including explicit coasts. No
provider settings or arbitrary order fields are accepted.

After validation, one SQLite transaction checks ownership, ban, lifecycle,
revision and phase again, writes a SUBMITTING receipt and immutable input job,
and changes ACCEPTING to DECIDING. The job pins board, objective definition,
human choices and report offset. Identical duplicate IDs return the saved
receipt even after restart or phase advance; changed payloads or competing
commands cannot replace accepted input. Invalid choices leave the phase editable.
Only the first accepted human submission refreshes activity, never AI work,
recovery or receipt replay.

Opponent work receives a recursively frozen clone. Validated opponent decisions
are persisted before RESOLVING. The rules adapter uses a disposable, all-human
GameRoom with no Socket.IO connection or AI seats, preserving the existing
movement/retreat/build rules without granting that room durable authority.
Only its proposed board/report cross back to storage. One transaction commits
the board, next phase, monotonic revision, public report, accepted receipt and
objective score. Report IDs come from the stable operation ID; repeat commit
acknowledgments do not produce another report. Objective evaluation reads this
committed report history, not an in-flight room.

Every asynchronous write includes operation ID, attempt ID, phase ID and
revision. Abandon/expire/stop/ban close the attempt and cancel its job/receipt
atomically. The service aborts local work; ignored aborts and late responses
cannot pass the durable fence. Operator authorization for calling stop/ban is a
separate API responsibility. Database checks also reject work after a ban from
another process even if that process cannot deliver an immediate local abort.

## Recovery and external work

A deadline, rejected provider promise, invalid decision or engine failure leaves
accepted choices in RECOVERING with a safe retry message. It never silently
reopens them for replacement. Recovery claims a new revision so an older worker
cannot commit. Saved decisions are reused; a crash after engine computation can
repeat the deterministic computation, but only one report commits. A crash after
commit only replays the accepted receipt.

Without saved decisions, recovery calls the provider's explicit `recover`
contract with the original operation ID. The future funded adapter must check
current attempt/ban/fence authority and atomically reserve before dispatch,
reconcile existing call IDs, retain unknown liabilities and count every retry.
It must not interpret recovery/cancellation as a refund or a new allowance.
The offline adapter needs no external reconciliation. DIC-58/60 remain open for
verification with actual durable accounting.

One service instance bounds executing phases and concurrent validation (default
three); one recovery batch attempts each pending job once. There is no unbounded
retry loop. A default 30-second phase deadline aborts rules/provider work and
bounds waiting even when an adapter ignores cancellation. Shutdown cancels and
drains local work; interrupted jobs remain recoverable. This is a single-server
MVP, not a multi-server paid-work scheduler.

## Verification

`npm run check` includes actual SIGKILL subprocess tests after durable intent,
saved decisions, rules computation and commit. Each reopen/recovery produces one
report and an idempotent accepted receipt. Other cases cover concurrent copies,
stale work after closure/ban/recovery, invalid choices, rejected promises,
timeouts with late responses, atomic rollback, worker capacity/shutdown,
retreat and winter fixture imports, and the full four-phase Tunis capture with
a pinned achievement surviving restart. Tests use temporary databases and the
offline adapter; they never load `.env`, call paid providers or send email.

Schema migration 2 adds phase jobs without modifying migration 1; its upgrade
test preserves existing players, sessions and attempts. Backups must remain
private. Rolling back across schema versions requires a compatible backup;
financial evidence must never be discarded or treated as fresh funding.

Schema migration 3 adds practice-mode attempts, durable start receipts and UTC
account counters. HTTP tests cover ownership, payload overrides, stale catalogs,
concurrent admission, quota persistence, idle races and restart. Browser evidence
covers real GitHub sign-in, four legal phases, API restart after the first phase,
Fall 1902 success/Early capture, saved replay, mobile layout and logout. These
checks use offline opponents and outbox mode, with no paid calls or live emails.
