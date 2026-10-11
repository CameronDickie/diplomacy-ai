# Sponsored Luna request contract

`server/src/providers/LunaPreset.ts` owns `luna-challenge-v5`, using only
`gpt-6-luna` at `https://api.openai.com/v1/responses`. It is separate from legacy
private-room seat/model policy. No visitor field is spread into API settings.
`buildLunaRequest` accepts only a server-built context string and returns immutable
serialized bytes plus their SHA-256 hash for durable call intent and reservation.
DIC-67 supplies the objective, board and numbered legal choices; the schema asks
for at most 34 integer choice indices. Godip remains the legality authority.

The request fixes Standard (`service_tier: default`), low reasoning, 2,048 output
tokens including reasoning, no tools, no streaming/background work, `store:false`
and disabled automatic truncation. There is no conversation or previous response
ID. Context is capped at 24,000 UTF-8 bytes, input at 32,768 tokens, response body
at 256 KiB, deadline at 20 seconds and automatic retries at zero. The HTTP
adapter enforces the response-body limit while reading, before allocating
an unbounded body. A caller must pass the preset deadline into `recordedCall`.
Changing bounds/settings/schema or prices requires a new contract version.
These are initial operating bounds, not measured game-quality/latency results.

## Prices and normalization

Official sources checked October 7, 2026:

- [Luna model, rates and capabilities](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Prompt caching usage formula](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Responses API contract](https://developers.openai.com/api/reference/python/resources/responses/methods/create)

Pricing version `luna-standard-2026-10-07` uses USD nanodollars per token:
ordinary input 100, cached input 10, cache writes 125, output 500. This is respectively
USD 0.10 / 0.01 / 0.125 / 0.50 per million tokens. Subtract cache reads and writes
from total input before pricing ordinary input. Reasoning is a subset of output,
so never add it again. The global endpoint avoids a regional-processing selection;
this contract does not price regional, priority, flex or batch requests.

`normalizeLunaResponse` projects only the safe response ID, normalized usage,
typed status and decision text. It never parses decision JSON. Pass its result to
`recordedCall`, which commits billing before JSON parsing/domain validation.
Refusals, incomplete responses, HTTP failures and malformed decision JSON retain
known usage. Raw provider errors, refusal text, reasoning and annotations are
not stored or exposed. Missing/inconsistent usage, unknown models/tiers or
unexpected tools fail the decision with unknown billing, preserving liability.

Output/input overruns fail the decision but retain all known actual token charges,
including the documented long-context rates if the input bound is violated.
A known charge is never clipped to an estimate. A future funding controller must
halt further paid dispatch on contract violations or unresolved billing requiring
reconciliation; it must not interpret an ERROR as evidence of zero spending.

## Funding and token verification

The durable ledger and decision provider now bind each request hash to an atomic
reservation and check stop/ban/current phase and global/attempt funding before
model dispatch. Unknown model outcomes stay held through recovery; known usage
is settled before parsing or validating the answer. Sponsored startup remains
interlocked; the evaluation CLI is the only real HTTP consumer.

The byte cap is a memory/prompt-size limit, not token verification. The HTTP
transport requires preflight through
[`POST /v1/responses/input_tokens`](https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count),
including the fixed schema, instructions and all input-affecting fields. The
[official counting guide](https://developers.openai.com/api/docs/guides/token-counting)
says this includes model framing/schema overhead. An invalid, unavailable,
oversized or cancelled count prevents model generation. The counted sender is
bound to the exact immutable body and usable once; changing any fixed setting
is rejected before counting. Counting creates no model response.

The ledger reserves the entire accepted input ceiling at the cache-write rate
plus all capped output, without assuming a cache hit. At the maximum accepted
input count this contract reserves USD 0.00512 per call. This is a conservative
hold, not measured cost, an allowance, or proof of access. Count failures release
only PREPARED unsent holds. Once model dispatch is claimed, failures and timeouts
retain uncertain liabilities exactly as before. Recovery re-counts prepared work
and reuses validated saved decisions without buying them again.

Live access, tactical quality, cost, latency and retry/fallback measurement remain
DIC-68. Mock tests need no credentials: build, then run
`node --test server/dist/test/LunaPreset.test.js`.

## Bounded opponent concurrency

The v2 contract pins at most six opponent decisions per phase. Each receives the
same committed board and only its own legal catalog; accepted human orders and
other powers' catalogs remain private. SQLite transactions admit each full-ceiling
hold and dispatch claim independently, so overlapping calls cannot overbook pool
or attempt limits. This changes scheduling, not model, request schema or prices.
The existing 30-second phase deadline and per-power recovery cap remain in force.

A first failure stops queued powers from starting. Calls already in flight are
NOT cancelled: they are paid for either way, so they finish, settle at their
real cost and their validated decisions are saved for the recovery to reuse.
Cancelling them would turn each into a worst-case held liability and spend the
sibling's recovery call for nothing. Only the outer signal (operator stop, ban,
abandon, phase deadline) cancels in-flight work. All workers account for their
outcomes before the provider returns. Unsent PREPARED holds are released for
that worker's revision only: an old drain cannot touch a newer recovery's
reservation. Dispatched unanswered calls remain held. Late known bills can
settle after cancellation, but aborted/stale actions cannot commit.

Each concurrent call holds a full worst case and settles for a fraction of it,
so six holds can exceed a pool or attempt cap that comfortably pays for the
phase. A hold that does not fit while another call of the same phase is still
unanswered is refused as `FUNDS_BUSY`, which pauses nothing; the power waits for
a sibling to settle and asks again. Width therefore degrades toward sequential
as funds tighten. Only a refusal with nothing of that phase in flight is real
exhaustion (`BUDGET_EXHAUSTED` pauses paid play; `ATTEMPT_BUDGET_EXHAUSTED`
ends the attempt's sponsored spend).

An attempt pinned to an older preset is refused before new provider calls; it
is never silently reconfigured. Operator replay/closure remains available. The
evaluation manifest pins v4 for the concurrency and request-local seeded mock
policy; older manifests are refused before dispatch. New configuration samples
use new run IDs in the SAME funded ledger, never a replacement grant. No live
result for this new policy is claimed by the offline tests.
