# Evaluating Luna opponents

`npm run evaluate` plays whole sponsored attempts of a pinned scenario through
the same funding ledger, decision provider and rules engine the game uses, with
a scripted human, and reports legality, latency, tokens and cost against the
launch targets. It is restartable and never buys the same answer twice.

**No live evaluation has been run.** Everything recorded so far uses the mock
transport, which exercises the plumbing and the accounting and says nothing
about the real model's quality, speed or price.

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

- **Manifest**: run ID, transport, scenario and version, script, seed, preset,
  price list, context version.
- **Per attempt**: outcome and achievements, phases, per-phase latency from the
  human's submission to the committed result (recoveries included), recoveries,
  calls by outcome, tokens (input, cached, output), and three separate money
  figures: **settled** (known bills), **held** (worst case for calls that never
  reported usage) and **reserved estimate** (sum of worst cases reserved).
- **Target check**, never adjusted to fit: mean attempt cost under USD 1
  (settled plus held, because an unanswered call may still be billed); phase
  latency p95 under 30 seconds; calls that were not a valid decision under 5 %.
- **Ledger reconciliation**: the change in the ledger's settled total must equal
  what the run's attempts settled. A mismatch exits non-zero.
- **Notes**: mock disclaimer, small-sample warning, and why a run stopped early.

A failed or unanswered call is counted, billed or held as the ledger has it, and
retried only through the provider's bounded recovery. An attempt that cannot
finish is closed and reported as stalled; its costs stay on the ledger.

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
4. `OPENAI_API_KEY` is set in the environment of that command. It is never read
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
silently become successful decisions. No live run has yet been recorded.
