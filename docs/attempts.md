# Durable phase execution

`server/src/attempts/AttemptService.ts` coordinates one human submission and six
opponents from a fixed, versioned challenge. It uses the SQLite worker and
bounded Godip executor. Its offline decision adapter holds, disbands retreats
and waives builds (or removes the required units deterministically). This is a
test policy, not the public Luna opponent.

This service is not yet exposed through browser routes or wired into production
startup. DIC-54 supplies the owned API/UI and admission integration. Legacy room
sockets remain separate and disabled in showcase. Paid provider dispatch remains
interlocked; no financial reservation is implied by saving a phase job.

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
verification with actual durable accounting, and DIC-59 for runtime integration.

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
