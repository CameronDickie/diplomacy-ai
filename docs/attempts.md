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

## Practice and sponsored attempts

Every attempt has one of three modes, chosen at start and never changed:

| Mode | Opponents | Start request | Cost |
| -- | -- | -- | -- |
| `PRACTICE` | hold every turn (`offlineDecisions`) | default | none |
| `BOT` | free scripted opponents (`practiceBot`) | `"mode":"BOT"` | none |
| `SPONSORED` | decided by the server-owned Luna preset (`LunaDecisionProvider`) | `"mode":"SPONSORED"` | reserved and settled through the funding ledger |

`mode` is the only optional field a start accepts. Model, preset, price list,
budget, board, persona and any other field are rejected. The attempt stores
`opponents`, the preset ID and its pricing version; a database trigger refuses
to change them, and `routedDecisions` picks the provider from that stored value
for every phase. A retried start returns the original attempt; reusing its
request ID with the other mode is a conflict, not a conversion. A sponsored
attempt in a process with no sponsored provider fails its phase and waits; it is
never decided by the practice provider.

A sponsored start is admitted in the same transaction as the quotas and only if
paid play is running and the pool can cover at least one worst-case call.
Otherwise it answers `409 SPONSORED_UNAVAILABLE`, creates nothing and consumes
no daily start; an empty pool also pauses paid play. The catalog reports
`sponsoredPlay` as `NOT_OFFERED`, `OPEN` or `PAUSED`, and while paused a signed-in
player can send one credit request per pause.

When a sponsored phase cannot be decided the attempt stays `RECOVERING` with the
player's orders saved, and its view carries a `notice`:

| Notice | Meaning | What the player can do |
| -- | -- | -- |
| `SPONSORED_PAUSED` | paid play is paused or out of budget | wait and continue when it resumes, or end the attempt |
| `ATTEMPT_BUDGET` | this attempt reached its per-attempt cap | end the attempt and review it |
| `SPONSORED_RETRY` | an opponent's answer was missing or unusable | try again (a new reserved call, at most three per power per phase) |

### Phases that ask nothing of the player

A player is only asked for input when they have a decision to make. After a
phase commits, if the next one asks nothing of them (another power's retreat, a
winter in which their units already match their supply centers, or a turn in
which they have no units), the server enters it on their behalf with the one
empty action available and resolves it. Each such phase is an ordinary durable
phase: its own job, the opponents' decisions, a report in the history. At most
seven follow one submission, so a player with no units cannot turn one click
into an unbounded run; past that, or if a followed phase needs recovery, the
attempt waits and the client shows what the phase is with a Continue button.

### Where sponsored play can run today

For players, nowhere with a real provider: `DIPLOMACY_PAID_AI_ENABLED=true` is
still refused at startup. The only path to a real provider from the server is the
development-only local playtest ([playtest.md](playtest.md)). `DIPLOMACY_LUNA_TRANSPORT=mock`
(local, non-production profile only) offers sponsored attempts against a
deterministic stand-in that reads the same request, answers in the provider's
format and is priced like a real answer, so the ledger, limits, notices and
recovery can all be exercised in a browser. The UI labels it "Mock Luna
opponents". It needs a grant in the local database:

```bash
npm run storage -- grant ./data/diplomacy.sqlite 0.05 local-mock-grant-1
```

### The practice bot

`server/src/attempts/PracticeBot.ts` is a deterministic opponent for free play.
Each unit heads for the nearest supply center it does not own, valuing an
arrival in Fall (when centers change hands) above one in Spring; no two units
are sent to the same place; a unit with nothing better to do supports a
friend's move or a threatened home center; a unit on a threatened home center
stays. Retreats prefer a center, builds fill free home centers with a rough
two-to-one balance of armies to fleets, and forced disbands take the units
furthest from home.

Every order is picked from the rules engine's legal catalog, so it is legal by
construction, and its small random tie-breaks are seeded from the attempt and
the phase: the same attempt replays identically and a recovery repeats the same
decision. It never reads the human's submitted orders, makes no provider call
and writes nothing to the ledger. It is a plain heuristic, not a strong player,
and it is never used for a sponsored attempt.
