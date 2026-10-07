# Sponsored Luna request contract

`server/src/providers/LunaPreset.ts` owns `luna-challenge-v1`, using only
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
at 256 KiB, deadline at 20 seconds and automatic retries at zero. The future HTTP
adapter must enforce the response-body limit while reading, not after allocating
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

## Funding integration still required

This module has no network client and reads no secrets. Sponsored startup remains
interlocked. DIC-64 must bind each serialized request hash to a durable atomic
reservation before transport, check stop/ban/expiry and remaining global/attempt
funding at dispatch, and preserve unknown liabilities through crashes. DIC-60/67
wire it into durable phase coordination. Do not call a provider directly merely
because request construction and normalization are implemented.

`lunaReservationNanousd` requires a verified input-token count or conservative
bound for the exact request, including instructions, message framing and schema.
The context byte check alone is not that verification; characters divided by four
is not a safe bound. Token counting must not omit schema or permit the body to
change after reservation. Reserve input at the cache-write rate and all capped
output with no assumed cache savings. At the maximum accepted input count this
contract reserves USD 0.00512 per call; that is a worst-case formula, not measured
cost, a funding allowance, or proof of model access.

Live access, tactical quality, cost, latency and retry/fallback measurement remain
DIC-68. Mock tests need no credentials: build, then run
`node --test server/dist/test/LunaPreset.test.js`.
