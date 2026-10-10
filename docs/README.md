# Documentation

Linear holds scope, status and release gates. These pages describe how the code
behaves. If a page here disagrees with the code, the code is right and the page
needs fixing.

## Current reference

| Page | Covers |
| -- | -- |
| [current-state.md](current-state.md) | what is built, what is not, and how to verify it |
| [architecture.md](architecture.md) | components, request flow and a code map |
| [first-challenge.md](first-challenge.md) | scenario rules, scoring and the development rotation |
| [board-fixtures.md](board-fixtures.md) | portable JSON boards and scenarios, import/export, witnesses |
| [attempts.md](attempts.md) | owned attempt flow, phase coordination, recovery |
| [storage.md](storage.md) | SQLite layout, migrations, backup/restore, retention, account deletion |
| [authentication.md](authentication.md) | GitHub/Google sign-in, sessions, the operator role |
| [limits.md](limits.md) | quotas, rate buckets and proxy trust |
| [funding.md](funding.md) | the cumulative budget ledger: grants, reservations, settlement, exhaustion |
| [operator.md](operator.md) | operator API, stop/ban controls, notification outbox |
| [operations.md](operations.md) | runbook for running the site |
| [configuration.md](configuration.md) | every runtime setting and profile |
| [deployment.md](deployment.md) | container image and Lightsail procedure |
| [release-evidence.md](release-evidence.md) | what has been verified, how, and what still blocks release |
| [evaluation.md](evaluation.md) | the evaluation harness, its report, and the conditions for a live run |
| [provider-accounting.md](provider-accounting.md) | recording every provider call before interpreting it |
| [luna-preset.md](luna-preset.md) | the fixed `gpt-6-luna` request and price contract |
| [haiku-preset.md](haiku-preset.md) | the alternative `claude-haiku-5-5` opponent contract, its prices, and running an evaluation in a locked-down container |
| [playtest.md](playtest.md) | development-only local play against real models, mixed per power, with a move, time and cost log |
| [luna-context.md](luna-context.md) | what an opponent request contains, its choices and its size bounds |
| [local-ai.md](local-ai.md) | optional Ollama opponents for self-hosted rooms: setup, guarantees, model choice |
| [build-baseline.md](build-baseline.md) | CI matrix and reproducible build notes |
| [public-showcase-tracking.md](public-showcase-tracking.md) | pointer to the Linear project |

## Historical

Kept for context. They describe plans and reviews written before the scenario
flow existed, and much of what they propose was replaced, deferred or built
differently. Do not follow their setup steps.

| Page | What it was |
| -- | -- |
| [roadmap.md](roadmap.md) | original full-game roadmap |
| [code-review-backlog.md](code-review-backlog.md) | repair checklist for the legacy room game |
| [public-showcase-review.md](public-showcase-review.md) | September 2026 technical review that led to the Linear plan |
| [playtest-feature-notebook.md](playtest-feature-notebook.md), [next-playtest-workstreams.md](next-playtest-workstreams.md), [playtest-iter2-feature-notebook.md](playtest-iter2-feature-notebook.md), [playtest-iter2-work-queue.md](playtest-iter2-work-queue.md) | playtest notes and work queues |
| [ai-cost-control-plan.md](ai-cost-control-plan.md), [ai-move-suggestion-plan.md](ai-move-suggestion-plan.md), [ai-turn-start-diplomacy-plan.md](ai-turn-start-diplomacy-plan.md), [llm-board-state-reliability-plan.md](llm-board-state-reliability-plan.md) | early AI design plans for the legacy room game |
| [discord-local-setup.md](discord-local-setup.md) | optional Discord integration; unavailable in the showcase profile and deferred |
