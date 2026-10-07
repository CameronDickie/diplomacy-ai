# Funding ledger

`server/src/storage/funding.ts` is the one place that decides whether a paid
provider call may begin. It is a cumulative ledger in SQLite, in integer USD
billionths (nanodollars), shared by every process, restart and experiment that
uses the database.

No paid call can happen today: the server still refuses to start with
`DIPLOMACY_PAID_AI_ENABLED=true`, and no provider transport is wired. The ledger
is in place so that the adapter has nothing to bypass when it arrives.

## The four numbers

| Figure | Meaning | Changes when |
| -- | -- | -- |
| **ceiling** | sum of explicit grants, optionally narrowed by `LLM_TOTAL_BUDGET_USD` | a grant is recorded |
| **settled** | every known cost ever reconciled | a call's usage first becomes known; never decreases |
| **held** | worst-case reservations for calls whose cost is not yet known | a call is prepared, settled or released |
| **available** | `ceiling − settled − held` | derived |

`held` is reported in two parts: **reserved** (prepared or dispatched, still
expected to answer) and **unknown liability** (finished, or answered, without
usable usage).

## Lifecycle of one call

1. **Reserve.** `prepareProviderCall` holds the intent's `maxCostNanousd` in the
   same transaction that checks the paid switch, the phase fence, that the
   attempt is active and the player is not banned, the per-attempt cap and the
   pool. If it does not fit, no call record is written. When it does not fit
   only because other calls of the same phase are still unanswered and holding
   their worst case, the refusal is `FUNDS_BUSY`: nothing is paused and the
   caller retries after one of them settles (`docs/luna-preset.md`).
2. **Dispatch.** Refused unless a live reservation exists for exactly that call.
   Recheck the total and attempt ceilings, so a policy narrowed after reservation
   cannot be bypassed by queued work. A refused call keeps its undispatched hold
   until it is explicitly released or its closed attempt is reconciled.
3. **Settle.** The first receipt with usage moves the reservation to settled at
   the real cost, once. A repeated or concurrent receipt changes nothing; a
   conflicting one is rejected.
4. **Uncertain.** A timeout, transport error, cancellation, crash or an answer
   without usage leaves the reservation held at its worst case, indefinitely,
   until a real bill settles it.

Nothing is refunded because a player abandoned, an attempt expired, an account
was banned or deleted, the process restarted, or cleanup ran.

## The only release

A call still `PREPARED` has provably not left the process, because dispatch is a
durable claim taken before any network use. Such a call can be released
(`releaseProviderCall`), which also marks it finished so it can never be
dispatched afterwards. The hourly sweep (`reconcileFunding`) does this for
prepared calls whose attempt is closed or gone. A dispatched call is never
released.

## Resolving a liability that never settles

A call that timed out or errored may never report usage, and its reservation
would otherwise stay held for good. After checking the provider's own records,
the owner can close it at the verified amount (zero if the provider confirms no
charge):

```bash
npm run storage -- held /data/diplomacy.sqlite
npm run storage -- resolve /data/diplomacy.sqlite <call-id> <USD> <authorization-reference>
```

Only a held reservation for a call that has ended can be resolved; one still in
flight cannot. A verified amount above the reservation or pool pauses spending
with the same anomaly handling as a direct provider bill. It is recorded in the operator audit trail, and an identical bill arriving
later for the same call is not charged again. If that bill is larger, an immutable
correction adds only the difference to global and attempt spending once, then
pauses paid play. A smaller bill leaves the conservative spent amount in place
and also pauses for review. The original resolution remains immutable. Correction
evidence survives receipt cleanup, backup and restart.

## Limits and refusals

| Refusal | When | Effect |
| -- | -- | -- |
| `ATTEMPT_BUDGET_EXHAUSTED` | settled + held for that attempt + this call would pass the per-attempt cap | that attempt only; the site keeps running |
| `BUDGET_EXHAUSTED` | this call's worst case exceeds what is available | paid play is paused through the operator switch, a new pause number opens, and the public catalog shows sponsored play as paused |

The per-attempt cap comes from `LLM_MAX_GAME_COST_USD` (default USD 1) and can
never exceed USD 15. A bill larger than its reservation is kept in full and
also pauses paid play (`COST_ANOMALY`), because the estimate it relied on was
wrong. Resuming without adding funds admits nothing: the next reservation
pauses again.

## Adding funds

Funds enter only through an explicit grant made with host access to the
database. There is no HTTP route, no automatic top-up and no initialization from
configuration, so a new or restored database has exactly the grants recorded in
it.

```bash
npm run storage -- funding /data/diplomacy.sqlite
npm run storage -- grant /data/diplomacy.sqlite <USD> <authorization-reference>
```

The amount is decimal dollars parsed as text (up to nine decimal places). The
reference is required, must be 8–100 characters, and makes the command
idempotent: repeating it changes nothing, and reusing a reference with a
different amount is an error. Grants cannot be edited or deleted. After a grant,
resume paid play in the operator view if it was paused.

`LLM_TOTAL_BUDGET_USD` is a brake, not a source: when paid AI is enabled the
effective ceiling is the smaller of the granted total and that setting.

Do not create a fresh database to get a clean ledger. Spend that has happened
belongs to the database it was recorded in; restore that database instead.

## What survives

Grants, settled spend, held reservations and per-attempt totals survive restart,
backup and restore. Detailed call records are pruned after
`DIPLOMACY_RECEIPT_RETENTION_DAYS` only once their cost is settled or released;
a held reservation and its call record are never pruned. Database triggers
refuse to lower settled spend, reopen a closed reservation, delete a held one,
or alter a grant.

## Evidence

`Funding.test.ts`: no grant admits nothing; idempotent and immutable grants;
exactly-once settlement under duplicate and concurrent receipts; held
liabilities through timeout, abandon, ban, account deletion, restart and
cleanup; release only before dispatch; the attempt cap; a new account drawing on
the same pool; over-estimate handling; 24 reservations racing over three
database connections never exceeding either limit; a process killed before
reserve, after reserve, after dispatch and after settlement; receipt pruning,
backup and restore leaving every total unchanged; and the grant command's exact
decimal parsing. All amounts in tests are synthetic.
