# Operator controls and notifications

Owner-only controls live under `/api/operator` and behind the "Operator" button
in the challenge UI. The operator is a signed-in **GitHub** identity whose
immutable numeric ID is listed in `DIPLOMACY_ADMIN_GITHUB_USER_IDS`. Every
request re-resolves the session and the allowlist from storage, so revoking the
session or removing the ID takes effect on the next request. A Google identity,
a room host or an ordinary player receives `403 OPERATOR_REQUIRED`; writes also
need an allowlisted `Origin`.

## What the operator can see

| Route | Returns |
| -- | -- |
| `GET /overview` | active/maximum attempts, the 50 most relevant attempts, spend totals, paid switch, outbox counts and recent messages, recent operator actions |
| `GET /attempts/:id` | public board, score, settled phase reports and per-attempt spend |

Attempts are shown with a pseudonymous account ID and provider only. Display
names, provider subjects, session material, submitted-order receipts, frozen
phase inputs, opponent decisions and provider request/response content are never
returned. Opening an attempt records a `SPECTATE` audit line (one per ten
minutes per attempt). The player-facing privacy text discloses this view.

The `funding` block comes from the ledger ([funding.md](funding.md)):
**available**, **settled** (all time), **reserved** (in flight) and **unknown
liability** (ended without usage), plus the per-attempt cap. `spend` is summed
from the detailed `provider_calls` rows still retained and adds token counts.

## What the operator can change

| Route | Effect |
| -- | -- |
| `POST /paid {"stopped":true\|false}` | Durable switch. While stopped, `prepareProviderCall` and `dispatchProviderCall` refuse every call, including queued and recovered work. Late bills for calls already in flight still reconcile. It never alters a budget. |
| `POST /attempts/:id/stop {}` | Closes the attempt as `STOPPED`, cancels its phase job and aborts in-flight work. |
| `POST /players/:id/ban {"banned":true\|false}` | Ban revokes sessions, drops live sockets, stops active attempts and blocks new sessions; an operator cannot ban their own account. |

Each running→stopped transition of the paid switch opens a new numbered
**pause**. All changes are written to `operator_audit`. None of these routes can
raise a limit, add budget or enable paid play: that remains configuration plus
the startup interlock.

The ledger flips the same switch when the pool is exhausted or a bill exceeds
its reservation (audit actions `BUDGET_EXHAUSTED` and `COST_ANOMALY`, operator
`system`), so exhaustion and an operator stop behave identically. No operator
route can add funds.

## Notifications

Events are written to the `outbox` table inside the transaction that causes
them and are delivered later by `Notifier`, so a slow or failing mail provider
never delays a start or a phase commit.

| Event | Dedupe key | When |
| -- | -- | -- |
| `ATTEMPT_STARTED` | `start:<attemptId>` | an attempt is admitted |
| `CREDIT_REQUEST` | `credit:<playerId>:<pause>` | a player asks for sponsored play while it is paused; one per account per pause |

Delivery is at-least-once with a lease: a sender that dies leaves the row due
again after the lease. Failures back off 1, 2, 4 … minutes (capped at an hour)
and stop as `FAILED` after eight tries. Only a short error code is stored, never
a provider response body. With `DIPLOMACY_NOTIFY_MODE=outbox` (the default)
nothing leaves the process and messages are read in the dashboard. With
`resend`, the dedupe key is sent as Resend's `Idempotency-Key`, so a retry after
an unknown outcome cannot produce a second email. Message text contains attempt,
challenge and pseudonymous account IDs only.

`POST /api/credit-request` currently answers `409` because sponsored play is
not offered while paid startup is interlocked; the store operation and its
per-pause deduplication are in place for when it is.

## Public availability

`GET /api/challenges` reports `capacity` (`OPEN`/`FULL`) and `sponsoredPlay`
(`NOT_OFFERED`, `PAUSED`, `OPEN`). The client turns these into a next action:
try again later when full, watch the replay, or ask the owner to resume
sponsored play when paused.

## Bot exhibition games

A background runner (`server/src/exhibition/`) plays whole games in which all
seven powers are the free practice bot. They make no provider call, never touch
the funding ledger and are separate from player attempts, so they use no player
capacity and cost nothing.

| Route | Who | Effect |
| -- | -- | -- |
| `GET /api/exhibitions`, `GET /api/exhibitions/:id` | anyone | list the ten most recent games; one game's summary and public phase reports |
| `POST /api/operator/exhibitions {"challengeId","challengeVersion","maxPhases"?}` | operator | start a game from a registered scenario's opening position (default 40 phases, at most 200) |
| `POST /api/operator/exhibitions/:id/pause` / `resume` / `cancel` | operator | as named; repeating an action that already took effect is harmless |

At most two games may be unfinished at once (paused games count). The runner
advances each running game a couple of phases per tick from a timer and never
inside a request. A game ends when the rules engine reports it over
(`GAME_OVER`), at its phase limit (`PHASE_LIMIT`), after 16 consecutive phases
with no change of ownership or unit count (`NO_PROGRESS`, shown as a draw), when
the same position occurs three times (`REPEATED_POSITION`, a draw), on operator
cancel, or after three consecutive rules-engine failures.

The position and phase count live in SQLite and each commit names the phase
number it expects, so after a restart the game continues from where it stopped
and neither a restart nor a second runner can commit a phase twice. The bot's
choices are seeded from the game ID and phase number, so a game is reproducible.
Finished games are removed with other results after the retention window.

Games played by Luna are deliberately not offered here: that would be a new way
to spend and needs an owner decision.
