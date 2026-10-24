# Provider-call evidence

`providers/RecordedCall.ts` and `storage/providerCalls.ts` provide the durable
accounting seam for the upcoming funded challenge adapter. Sponsored attempts use
them whenever paid AI is available. These records alone do **not** reserve or authorize funds;
DIC-64 must atomically admit a funded call before this seam can dispatch it.
The caller must not use an estimate as permission to spend.

Each immutable intent identifies its call, logical phase operation, attempt,
power, phase task, provider/model, pricing version, request-content hash and
conservative maximum cost. No request text, provider output, error body,
credential or account email is stored. Nanodollars are integer USD billionths,
so sub-microdollar token prices can be added without per-token rounding. The
priced provider adapter must compute costs from verified usage and its pinned
pricing policy; this repository does not invent a price for missing usage.

Preparation and dispatch check the current phase/revision, active attempt,
unbanned player and opponent task. Dispatch claims a prepared call in a SQLite
transaction; competing processes cannot dispatch the same ID. A changed payload
under the same ID is a conflict. Crash after a claim is uncertain, even if the
network operation might not have begun. Do not simply re-dispatch it on restart.

The injected transport returns normalized usage separately from response text.
The recorder persists that usage before JSON parsing or legal-action validation.
Malformed output, refusal, incomplete output and invalid actions retain their
billable record. Missing/partial/inconsistent usage must remain unknown; it is
never silently zero. Each retry needs its own call ID under the original logical
operation, and contributes separately. Known usage reconciles exactly once;
conflicting receipts cannot overwrite it. A provider response ID cannot be
credited to two local calls.

A deadline or abort bounds waiting even if transport/validation ignores the
signal. Its outcome remains timeout/cancelled. Late usage is still accepted
after phase closure, ban or recovery, because billing and game authority are
separate. It cannot change the terminal outcome or commit a game decision.
Storage failure fails closed: inspect durable state before retrying, since a
write may already have committed. Known cost above an estimate is retained in
full, never clipped; the budget layer must halt further admission on that anomaly.

`providerCallsForOperation` gives bounded recovery metadata and
`providerCallTotals` separately reports known cost and unresolved conservative
liability. Prepared records also retain liability until a future funding
reconciler explicitly proves dispatch could not happen. Records deliberately
have no cascading attempt/account foreign key: retention/deletion must not erase
financial evidence accidentally. DIC-62/64 will define compaction into durable
pool totals and outstanding liabilities; detailed receipts are retained90 days.
No public HTTP endpoint exposes these private records.

Migration4 appends the call table and immutable-intent trigger. Do not modify
shipped migrations. Tests cover output failures, duplicate transport/receipts,
retry IDs, missing/invalid usage, separate Store connections, late receipts after
abandonment, cancellation during validation, phase/ban fences, strict metadata,
backup/reopen and SIGKILL at prepared/dispatched/received/finished boundaries.
All tests use mock transports and synthetic pricing; they prove accounting
semantics, not official Luna pricing, funded admission or live quality.

Next integration: DIC-66 supplies the exact Responses/preset/pricing contract;
DIC-64 supplies durable total/per-attempt reservations and stop checks; DIC-60
uses these records for paid recovery; DIC-67 supplies bounded private-safe
prompts. That integrated path is what sponsored attempts use; the staging check
exercises it end to end with a stand-in provider.
