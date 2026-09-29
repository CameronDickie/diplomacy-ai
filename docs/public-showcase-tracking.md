# Public showcase implementation tracking

Linear is the source of truth for issue status, acceptance criteria, and dependencies.
This file is an entry point for repository contributors; do not maintain a second
completion checklist here.

- [Project: Diplomacy — public showcase MVP](https://linear.app/dickielabs/project/diplomacy-public-showcase-mvp-65f956fd6c82)
- [MVP implementation plan and release gates](https://linear.app/dickielabs/document/mvp-implementation-plan-and-release-gates-488997679a3e)
- [Technical review](public-showcase-review.md)

Created September 27, 2026: 25 MVP issues, 6 deferred issues, five MVP milestones,
and one deferred milestone. Every issue has scope, acceptance criteria, priority,
and code/review references. Dependency links were read back and verified.

## First implementation batch

1. [DIC-49: Build and CI baseline](https://linear.app/dickielabs/issue/DIC-49/restore-a-reproducible-build-and-establish-the-ci-baseline).
2. [DIC-48: Product, budget, retention, and release decisions](https://linear.app/dickielabs/issue/DIC-48/define-the-mvp-rules-funding-limits-and-release-acceptance-criteria).
3. [DIC-50: Runtime/deployment configuration](https://linear.app/dickielabs/issue/DIC-50/unify-runtime-configuration-and-preserve-ai-limits-through-deployment).
4. [DIC-61: Bounded asynchronous Godip execution](https://linear.app/dickielabs/issue/DIC-61/run-godip-asynchronously-with-execution-and-concurrency-limits).
5. [DIC-51: Guest/admin capability boundaries](https://linear.app/dickielabs/issue/DIC-51/separate-guest-game-access-room-ownership-and-admin-capabilities).

The first two issues start in Todo; dependent work starts in Backlog. No
implementation has been marked in progress or complete by this planning setup.
Follow current Linear state rather than treating this initial order as a schedule.

## Issue index

### 01 — Access and configuration

- [DIC-48: Define the MVP rules, funding limits, and release acceptance criteria](https://linear.app/dickielabs/issue/DIC-48/define-the-mvp-rules-funding-limits-and-release-acceptance-criteria)
- [DIC-49: Restore a reproducible build and establish the CI baseline](https://linear.app/dickielabs/issue/DIC-49/restore-a-reproducible-build-and-establish-the-ci-baseline)
- [DIC-50: Unify runtime configuration and preserve AI limits through deployment](https://linear.app/dickielabs/issue/DIC-50/unify-runtime-configuration-and-preserve-ai-limits-through-deployment)
- [DIC-51: Separate guest game access, room ownership, and admin capabilities](https://linear.app/dickielabs/issue/DIC-51/separate-guest-game-access-room-ownership-and-admin-capabilities)
- [DIC-52: Disable Discord and voice in showcase deployments and isolate admin integration hooks](https://linear.app/dickielabs/issue/DIC-52/disable-discord-and-voice-in-showcase-deployments-and-isolate-admin)

### 02 — Playable guest experience

- [DIC-53: Implement a useful deterministic bot for guest play and provider fallback](https://linear.app/dickielabs/issue/DIC-53/implement-a-useful-deterministic-bot-for-guest-play-and-provider)
- [DIC-54: Build one-click guest solo setup with server-owned opponent presets](https://linear.app/dickielabs/issue/DIC-54/build-one-click-guest-solo-setup-with-server-owned-opponent-presets)
- [DIC-55: Use the authoritative legal-order catalog in human order entry](https://linear.app/dickielabs/issue/DIC-55/use-the-authoritative-legal-order-catalog-in-human-order-entry)
- [DIC-56: Make diplomatic messages acknowledged, durable, and idempotent](https://linear.app/dickielabs/issue/DIC-56/make-diplomatic-messages-acknowledged-durable-and-idempotent)
- [DIC-57: Add a prepared public replay and a clear first-game introduction](https://linear.app/dickielabs/issue/DIC-57/add-a-prepared-public-replay-and-a-clear-first-game-introduction)

### 03 — Reliable game lifecycle

- [DIC-58: Coordinate negotiation cutoff and phase decisions using immutable snapshots](https://linear.app/dickielabs/issue/DIC-58/coordinate-negotiation-cutoff-and-phase-decisions-using-immutable)
- [DIC-59: Persist games, seat identities, histories, and command receipts in SQLite](https://linear.app/dickielabs/issue/DIC-59/persist-games-seat-identities-histories-and-command-receipts-in-sqlite)
- [DIC-60: Make phase commits transactional and recover interrupted resolution](https://linear.app/dickielabs/issue/DIC-60/make-phase-commits-transactional-and-recover-interrupted-resolution)
- [DIC-61: Run Godip asynchronously with execution and concurrency limits](https://linear.app/dickielabs/issue/DIC-61/run-godip-asynchronously-with-execution-and-concurrency-limits)
- [DIC-62: Bound game lifetime, retained state, and disconnected-player behavior](https://linear.app/dickielabs/issue/DIC-62/bound-game-lifetime-retained-state-and-disconnected-player-behavior)

### 04 — Bounded hosted AI

- [DIC-63: Account for every provider attempt before parsing and game validation](https://linear.app/dickielabs/issue/DIC-63/account-for-every-provider-attempt-before-parsing-and-game-validation)
- [DIC-64: Enforce durable global and per-game budgets with atomic reservations](https://linear.app/dickielabs/issue/DIC-64/enforce-durable-global-and-per-game-budgets-with-atomic-reservations)
- [DIC-65: Rate-limit public commands and bound room and AI work admission](https://linear.app/dickielabs/issue/DIC-65/rate-limit-public-commands-and-bound-room-and-ai-work-admission)
- [DIC-66: Fix role-based model routing and register a priced Luna preset](https://linear.app/dickielabs/issue/DIC-66/fix-role-based-model-routing-and-register-a-priced-luna-preset)
- [DIC-67: Bound AI context and specialize prompts by task](https://linear.app/dickielabs/issue/DIC-67/bound-ai-context-and-specialize-prompts-by-task)
- [DIC-68: Evaluate Luna game quality, latency, and total cost against MVP targets](https://linear.app/dickielabs/issue/DIC-68/evaluate-luna-game-quality-latency-and-total-cost-against-mvp-targets)

### 05 — MVP release gate

- [DIC-69: Expose admin cost controls and honest public AI availability states](https://linear.app/dickielabs/issue/DIC-69/expose-admin-cost-controls-and-honest-public-ai-availability-states)
- [DIC-70: Verify guest play, recovery, privacy, and spending limits end to end](https://linear.app/dickielabs/issue/DIC-70/verify-guest-play-recovery-privacy-and-spending-limits-end-to-end)
- [DIC-71: Prepare open-source licensing, setup, and operator documentation](https://linear.app/dickielabs/issue/DIC-71/prepare-open-source-licensing-setup-and-operator-documentation)
- [DIC-72: Complete staged deployment and the public MVP release checklist](https://linear.app/dickielabs/issue/DIC-72/complete-staged-deployment-and-the-public-mvp-release-checklist)

### Later — Optional extensions

- [DIC-73: Add Ollama for clone owners and self-hosted local AI](https://linear.app/dickielabs/issue/DIC-73/add-ollama-for-clone-owners-and-self-hosted-local-ai)
- [DIC-74: Assess browser-local inference and fully local solo play](https://linear.app/dickielabs/issue/DIC-74/assess-browser-local-inference-and-fully-local-solo-play)
- [DIC-75: Harden optional Discord text linking and bot readiness](https://linear.app/dickielabs/issue/DIC-75/harden-optional-discord-text-linking-and-bot-readiness)
- [DIC-76: Repair and validate the optional Discord voice lifecycle](https://linear.app/dickielabs/issue/DIC-76/repair-and-validate-the-optional-discord-voice-lifecycle)
- [DIC-77: Extract remaining GameRoom responsibilities behind explicit domain APIs](https://linear.app/dickielabs/issue/DIC-77/extract-remaining-gameroom-responsibilities-behind-explicit-domain)
- [DIC-78: Add a bounded background runner for all-AI games](https://linear.app/dickielabs/issue/DIC-78/add-a-bounded-background-runner-for-all-ai-games)

## Working convention

Claim and start the relevant issue when implementation begins. Link its PR or
commit and meaningful verification evidence. Mark Done only when acceptance
criteria pass; record remaining limitations. Keep new discoveries linked and
classify them as MVP requirements or deferred work. Preserve the existing game
rules, private press boundaries, and submission idempotency.

Budget values, retention, short-game rules, benchmark targets, and the license
choice are decisions tracked in DIC-48. Do not infer production
funding or deployment approval from the existence of the plan.

