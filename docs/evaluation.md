# Evaluating Luna opponents

`npm run evaluate` plays whole sponsored attempts of a pinned scenario through
the same funding ledger, decision provider and rules engine the game uses, with
a scripted human, and reports legality, latency, tokens and cost against the
launch targets. Its durable manifest, phase timings and recovery counters survive
restarts, so resuming a run reuses committed answers and preserves its evidence.

**First live baseline completed October 7, 2026.** One v2 attempt of the
Tunis development pilot finished with objective failure. Its private ledger
reconciled and retained uncertain billed liabilities. The conservative cost
target passed; phase latency and unusable-call targets missed. One attempt is
indicative only: the sequential preset is a **no-go for public sponsored play**
until improved and measured again. Detailed measurements and financial records
remain in the private operator report.

The v3 harness fixes scripted adjustment selection: it uses legal structured
build/disband defaults rather than selecting every empty home or parsing display
copy. The policy version changes deliberately. A v2 run cannot be adopted by
v3; keep its completed evidence and use a new run ID in the **same funded ledger**
for a new policy sample. No new allowance is implied.

## Mock run (no key, no network)

```bash
npm run build
npm run storage -- init /tmp/eval.sqlite
npm run storage -- grant /tmp/eval.sqlite 0.20 mock-eval-grant-1
npm run evaluate -- --db /tmp/eval.sqlite --run mock-a --attempts 3 --out /tmp/eval-report.json
```

| Option | Meaning |
| -- | -- |
| `--db` | the ledger database; funds must already be granted in it |
| `--run` | run ID; re-running it resumes instead of repeating |
| `--scenario`, `--script` | scenario fixture and the witness that scripts the human (default `tunis-expedition`, `early-capture`); unlisted units hold |
| `--attempts` | how many attempts the run should contain in total |
| `--seed` | seed for the mock's choices |
| `--out` | write the full JSON report (never overwrites) |

Recorded mock result on October 6, 2026 (three attempts of `tunis-expedition`,
`early-capture`, seed 1): 15 phases, 78 calls, all valid; about USD 0.0023
settled per attempt at the mock's token counts; its old byte-based reservation
estimate is superseded by the full-ceiling hold. Previously about USD 0.037 reserved per
attempt at worst case; ledger reconciled. These are stand-in numbers.

## What the report contains

- **Manifest**: immutable run ID, transport, scenario/version and fixture hash,
  script, seed, preset and preset hash, price list, context/harness versions,
  timing policy and per-phase recovery limit. The requested number of attempts
  can grow without changing the run identity.
- **Per attempt**: outcome and achievements, phases, per-phase latency from the
  accepted submission to the committed result (restart downtime included),
  durable phase identities/timestamps and recovery counts,
  calls by outcome, tokens (input, cached, output), and three separate money
  figures: **settled** (known bills), **held** (worst case for calls that never
  reported usage) and **reserved estimate** (sum of worst cases reserved).
- **Target check**, never adjusted to fit: mean attempt cost under USD 1
  (settled plus held, because an unanswered call may still be billed); phase
  latency p95 under 30 seconds; calls that were not a valid decision under 5 %.
- **Ledger reconciliation**: the change in the ledger's settled total must equal
  what the run's attempts settled. A mismatch exits non-zero.
- **Notes**: mock disclaimer, small-sample warning, missing timing evidence and
  why a run stopped early. Latency is inconclusive if any committed phase lacks
  a valid duration; missing evidence never becomes a zero-duration sample.
  Local rules/submission errors produce an `INTERRUPTED` report with a generic
  note, not the raw error. The CLI writes the report and exits 1. The saved
  active attempt remains resumable and no later attempt starts. Financial
  reconciliation failure exits 2; configuration and unreadable-store errors
  still fail rather than fabricating a report.

A failed or unanswered call is counted, billed or held as the ledger has it, and
retried only through the provider's bounded recovery. An attempt that exhausts
its recovery/phase limits is closed and reported as
stalled; its costs stay on the ledger. A local evaluation error preserves active
state for repair and resume. Any non-completed attempt makes full-attempt mean
cost unavailable; passing latency/quality checks are inconclusive, while
observed misses remain visible. Per-attempt settled and held totals are always
reported independently of whether the game completed.

## Resuming and retaining evidence

Migration 13 stores the manifest before any evaluation dispatch. Each measured
phase starts in the transaction that accepts its intent and completes in the
transaction that commits its board. The timing policy uses epoch milliseconds
from accepted submission through commit, including process downtime. Explicit
recoveries increment a durable counter; restarting does not replenish the
configured recovery allowance. A backward wall clock leaves the duration
unknown without rejecting a valid game result.

Reusing a run ID with a different fixture, preset, script, seed, transport or
policy is refused before dispatch. Runs created before durable manifests cannot
be adopted; choose a new run ID. Backup/restore preserves the manifest and phase
evidence. After raw attempt retention expires, the permanent run/attempt mapping
refuses to recreate that attempt under the same run ID, avoiding another purchase.

These private operator benchmark records contain configuration hashes,
pseudonymous run/operation IDs, timestamps and counters. They contain no raw
boards, player chat, reasoning or credentials. Their permanent aggregate evidence
is separate from retained visitor attempt content. Keep the ledger and reports
private.

## What this cannot tell you

Opponents choose differently on every attempt, so results are not comparable
between players and there is no leaderboard. The scripted human is a fixed
baseline, not a strong player. A small sample gives indicative rates only; the
report says so when there are fewer than 30 attempts.

## Live run (owner only)

A live run calls the real provider and spends real money. The tool refuses it
unless **all** of these are true, each of which only the owner can arrange:

1. `--live` is given.
2. `--authorization-ref` names a funding grant already recorded in the database
   (`npm run storage -- grant …`). Recording that grant is the authorization.
3. The database already exists. Use the one that holds all earlier spend; a new
   database would hide it.
4. The preset's key is set in the environment of that command: `OPENAI_API_KEY`
   for `--preset luna` (the default), `ANTHROPIC_API_KEY` for `--preset haiku`
   ([haiku-preset.md](haiku-preset.md), which also covers running in a container). It is never read
   from a file or an argument and never printed.
5. `--attempts` is at most 10.

```bash
npm run storage -- funding /path/to/ledger.sqlite
OPENAI_API_KEY=… npm run evaluate -- --db /path/to/ledger.sqlite --run live-1 --attempts 3 \
  --live --authorization-ref <the-grant-reference> --out live-1.json
```

Spend is bounded by the ledger whatever the flags say: each call reserves its
worst case first, and the run stops when the pool or an attempt's cap is
reached. Start with a few attempts, read the report, and add attempts to the
same run ID only if more evidence is needed. Keep the JSON report privately; it
contains no prompts, answers or keys, but it does contain cost figures.

The game server itself still refuses to start with paid AI enabled. A go/no-go
for offering sponsored play publicly should cite a live report against the three
targets above.

## Exact input verification

Live evaluation uses the fixed HTTP token-counting preflight described in
[luna-context.md](luna-context.md). Every generation has a full-ceiling ledger
hold before counting; a valid count within the ceiling precedes the durable
model dispatch claim. Mock transport does not call the counter or provider and
its synthetic token counts cannot verify real cost or latency. Failed counts
are unsent cancellations, so they remain visible in call outcomes; they do not
silently become successful decisions. Real calibration is underway; its partial
sample is not a release approval.

## Concurrent policy calibration

Harness v4 introduced preset `luna-challenge-v2` (now `luna-challenge-v4` after the
instruction changes in [luna-context.md](luna-context.md)) with at most six independent opponent
decisions in flight. It preserves the v3 scripted adjustment fix and pins
request-local seeded mock choices, so response order cannot scramble a mock
run. Existing v2/v3 manifests and older funded presets are refused before new
dispatch, rather than silently adopting these settings. Preserve their reports;
a new policy sample uses a new run ID with the SAME persistent funded ledger.

Offline overlap, concurrent admission, tight-budget waiting, failed-sibling, late-bill and
parallel SIGKILL tests verify the scheduling/accounting contract. They do not
establish the new policy's live latency or quality. The original sequential
no-go remains until measured calibration supports a different decision.
