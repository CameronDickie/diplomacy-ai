# The Claude Haiku 5.5 opponent preset

A second sponsored-opponent contract, alongside [luna-preset.md](luna-preset.md).
It uses `claude-haiku-5-5` through the official Anthropic SDK. Everything
around the model is shared with Luna and unchanged: the funding ledger, the
worst-case reservation before every call, exactly-once settlement, recovery,
legal-order validation and the bounded per-power context
([funding.md](funding.md), [luna-context.md](luna-context.md)).

**Status: first live baseline completed October 9, 2026; not enabled for
players.** The server still refuses to start with paid AI enabled.

## Live baseline (October 9, 2026)

One owner-authorized run of ten attempts of the Tunis development pilot, in the
locked-down container, against a fresh ledger volume. The live API accepted the
pinned request unchanged.

| Target | Measured | Result |
| -- | -- | -- |
| Mean attempt cost under USD 1 | about USD 0.011 (highest attempt about USD 0.012) | met |
| Phase latency p95 under 30 s | 4.7 s (median 3.1 s, slowest phase 7.9 s) | met |
| Under 5 % calls that were not a valid decision | 0.5 % (2 of 407) | met |

- 80 phases, 407 calls, none stalled. Every phase was timed.
- The two unusable calls were illegal selections (`INVALID_ACTION`). Each was
  recovered by one further reserved call; no phase waited on a player.
- No refusals, no truncated answers, no timeouts, no unknown bills. Nothing was
  left held and the ledger reconciled to the settled total.
- No prompt caching occurred, as intended.

What this does **not** show:

- **How well it plays.** The scripted human failed its objective in all ten
  attempts, as it also does against the random mock and did against Luna, so
  that outcome measures the script, not the opponents. Judging play needs a
  person to play attempts and read the opponents' orders.
- **Other scenarios.** One scenario and one script were sampled.
- **Rates.** Ten attempts are indicative; the report says so itself.

The detailed report and ledger stay in the private evaluation volume.

## One preset per deployment, one per attempt

`DIPLOMACY_SPONSORED_PRESET` is `luna` (default) or `haiku`. New sponsored
attempts are pinned to that preset's ID and price list. An attempt never
changes preset: one started under the other preset is refused before any call,
not reconfigured. An evaluation run is pinned the same way through its manifest.

The seam is `server/src/providers/OpponentContract.ts`. A preset supplies only
its exact request, its worst-case price, and how to read its provider's answer.

## The pinned request (`haiku-challenge-v1`)

| Setting | Value | Why |
| -- | -- | -- |
| Model | `claude-haiku-5-5` | fixed; not configurable per request |
| Output cap (`max_tokens`) | 4,096 | thinking counts toward the cap, so it is twice Luna's |
| Thinking | adaptive | on by default for this model |
| Effort | `low` | order selection from a numbered list; keeps thinking and latency down |
| Output | JSON schema `{"choices":[integers]}` | the same answer shape as Luna |
| Input bound | 32,768 tokens, verified by the token-counting endpoint before dispatch | |
| Context / request size | 24,000 / 32,768 bytes | same as Luna |
| Timeout / retries | 20 s / none | a retry would be a second, unreserved bill; the SDK's retries are off |
| Concurrency | up to 6 decisions per phase | same bounded dispatch as Luna |

Deliberately absent: sampling settings (rejected by this model), tools, prompt
caching (`cache_control`), and `fallbacks` (this model has no server-side
fallback, and another model's rates must never apply to a reserved call).

The schema carries no numeric or length limits because the API rejects them.
The limits (at most 34 indices, each 0–100,000) are applied when the answer is
parsed, before legal validation, as for Luna.

## Prices and the reservation

Price list `haiku-5-5-standard-2026-10-08`, in USD per million tokens, for
prompts of at most 100,000 tokens:

| Input | Cache read | Cache write (5 min / 1 h) | Output (includes thinking) |
| -- | -- | -- | -- |
| 0.10 | 0.01 | 0.125 / 0.20 | 0.50 |

Each call reserves **32,768 input tokens at the dearest input rate plus the
whole output cap**: USD 0.0086016. Real calls settle far below that. A test
asserts that no bill inside the preset's bounds can exceed the reservation.

Prompts above 100,000 tokens are billed at five times these rates. The input
bound keeps requests far below that; if a provider answer ever reports more,
the real bill is kept at the higher rate and the call fails.

If Anthropic changes these prices, change the preset and its `pricingVersion`
together. Attempts pinned to the old version are then refused, not repriced.

## Reading the answer

Billing fields are recorded before the answer is interpreted.

- The answer is read by block type. A response normally begins with a
  `thinking` block; its text is never stored.
- `input_tokens` excludes cached tokens on this API, so the stored input total
  is input + cache read + cache write, each at its own rate.
- A **safety decline** (`stop_reason: "refusal"`) is a normal, billed answer and
  is recorded as `REFUSED`. The decline's category and explanation are not
  stored.
- **`max_tokens`** (thinking used the whole cap) is recorded as `INCOMPLETE`.
- Another model, another service tier, any tool activity, or missing or
  inconsistent usage means the price is unknown: the reservation stays held at
  its worst case and the call fails. It is never treated as free.

Any unusable answer goes through the existing recovery: a new reserved call, up
to the per-power call limit, then the phase waits. Holds are never substituted
for a paid decision.

## Running it in a container

`scripts/evaluate-in-container.sh` runs the harness inside the production image
with the ledger on a dedicated named volume:

- read-only root filesystem, no Linux capabilities, no privilege escalation,
  bounded memory and processes;
- write access to that one volume only;
- **no network at all** for mock runs;
- for `--live` runs, the network and exactly one provider key, the one the
  chosen preset uses, passed by name from your shell and never on a command line.

Offline, no key, no spend:

```bash
scripts/evaluate-in-container.sh haiku-eval storage init
scripts/evaluate-in-container.sh haiku-eval storage grant 1 mock-only-0001
scripts/evaluate-in-container.sh haiku-eval evaluate --run haiku-mock-1 --preset haiku --attempts 1
```

The mock grant is a number in a throwaway database, not money. Use a different
volume for a live run so mock figures never mix with real spend.

## A live run (owner only)

This spends real money on the Anthropic API. Scope it at both ends:

1. **At Anthropic:** create a dedicated workspace for this experiment, set a
   spend limit on it, and create an API key in that workspace. The key then
   cannot spend beyond that limit whatever this code does.
2. **Here:** record a funding grant in a fresh volume's ledger. The run cannot
   reserve more than the grant, and it stops when the pool is exhausted.

```bash
scripts/evaluate-in-container.sh haiku-live storage init
scripts/evaluate-in-container.sh haiku-live storage grant <usd> <your-reference>
export ANTHROPIC_API_KEY   # set it in this shell without echoing it
scripts/evaluate-in-container.sh haiku-live evaluate --run haiku-live-1 --preset haiku \
  --attempts 1 --live --authorization-ref <your-reference> --out /data/haiku-live-1.json
scripts/evaluate-in-container.sh haiku-live storage funding
```

The same refusals apply as for Luna ([evaluation.md](evaluation.md)): no grant
under that reference, no key, a missing database, or more than 10 attempts
stops the run before anything is sent. Start with one attempt. Read the report
against the unchanged targets (mean attempt under USD 1, phase p95 under 30 s,
under 5 % unusable calls) and keep the report private.

A Haiku result says nothing about Luna and the reverse. Enabling live sponsored
play for either still requires the reviewed change described in
[operations.md](operations.md).

## Verification

`server/src/test/HaikuPreset.test.ts`: the pinned request and what it excludes;
the worst-case reservation; billing arithmetic including cache and long-prompt
rates; refusal, truncation and unknown-price handling; the SDK transport against
a stand-in endpoint (exact-input count first, single-use sender, tampered
requests refused before any request, no retry on 429/500/529); whole attempts
through the ledger recorded under `ANTHROPIC` / `claude-haiku-5-5`; and refusal
to continue a run under the other preset. The whole Luna suite still passes
unchanged through the shared contract.

These are contract tests against the documented API and SDK types. The live
baseline above shows the live API accepts this exact request.
