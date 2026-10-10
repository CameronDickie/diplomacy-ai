# Release evidence

A requirement-by-requirement record of what has been verified and how. "Offline"
means automated tests with mocked providers and mail, or a local server or
container using locally seeded test sessions. Nothing here is evidence from a
deployed site or a live notification email, because neither has happened. The
only paid provider calls ever made are one owner-funded evaluation attempt of
the sequential Luna preset on October 7, 2026, and one ten-attempt evaluation run
of the Haiku preset on October 9, 2026; the game server has made none.

The 31 container checks in `scripts/staging-check.sh` last passed against
master `7c9b3e2` on October 8, 2026, after the concurrent-dispatch and Ollama
merges. The Haiku preset merged afterwards is covered by CI's image job and its
own container run, not by a fresh staging pass.

Status: **not release-ready.** The open rows below are blockers.

| Requirement | Status | Evidence |
| -- | -- | -- |
| Reproducible build, CI on two platforms, production image | Verified offline | `npm run check`; CI matrix; clean-clone run recorded in [current-state.md](current-state.md) |
| GPL-3.0-only source, Godip/map/font notices, source in the image | Verified offline | CI image job; `scripts/staging-check.sh` (packaged notices and source, public `/legal.html`, `/LICENSE.txt`) |
| GitHub and Google sign-in, separate identities, revocable sessions | Verified offline; real providers once on localhost | `Auth.test.ts`; recorded in Linear DIC-51 |
| Operator role limited to the allowlisted GitHub identity | Verified offline | `AccessMatrix.test.ts`, `Operator.test.ts`, staging check |
| Every API route classified and enforced across restart | Verified offline | `AccessMatrix.test.ts` |
| Public intro and sanitized replay with providers disabled | Verified offline | `ChallengeService.test.ts`, staging check, browser pass |
| Owned start, resume, legal menus, submit, results, history | Verified offline | `ChallengeService.test.ts`, `ChallengeLegal.test.ts`, browser passes, staging check |
| Deterministic scoring on settled Fall turns | Verified offline | `TunisPilot.test.ts`, `BoardFixture.test.ts` witnesses for all six scenarios |
| UTC-day rotation with pinned attempts | Verified offline | `Rotation.test.ts`, browser win on the featured slot |
| Durable phases, crash recovery, idempotent retries | Verified offline | `AttemptService.test.ts` (process kill at four boundaries), `Store.test.ts` |
| Quotas, idle expiry, rate limits, proxy trust | Verified offline | `ChallengeService.test.ts`, `RateLimits.test.ts` |
| Retention and account deletion without losing cost records | Verified offline | `Retention.test.ts`, browser delete flow |
| Provider calls recorded before interpretation; late bills reconcile | Verified offline | `ProviderAccounting.test.ts`; terminal-call/revision fences and late manual-resolution correction regressions |
| Paid stop, attempt stop, ban; enforcement at dispatch | Verified offline | `Operator.test.ts`, browser pass of the operator view |
| Notifications once per event, retry, no blocking of play | Verified offline with a mocked mail adapter | `Operator.test.ts` |
| Backup, restart and restore preserve identity, attempts, reports, spend, unresolved liability | Verified in a local container | `scripts/staging-check.sh` |
| Rollback | Procedure documented; older-image refusal covered by migration-mismatch tests | [deployment.md](deployment.md), `Store.test.ts` |
| One end-to-end journey over HTTP: guest → mocked GitHub sign-in → practice win with early capture → restart → sponsored attempt (mock opponents) → operator oversight → pause, wait, credit request, resume → account deletion → sign-out | Verified offline in CI | `Journey.test.ts` |
| Browser journeys in CI (Chromium): guest page and replay, phone width, practice turn with replay isolation and reload, mock sponsored attempt, operator pause/resume and access refusal, account deletion | Verified in CI against the local profile with mock opponents and generated test sessions; real sign-in is not exercised | `e2e/journey.spec.ts` |
| Free practice bot: whole attempts through builds without a stall, reproducible, legal on coast/convoy/retreat/build fixtures | Verified offline and in the browser journeys | `PracticeBot.test.ts`, `e2e/journey.spec.ts` |
| Budget ledger: grants, reservations, per-attempt and total caps, exhaustion, crash safety | Verified offline with synthetic amounts | `Funding.test.ts` including late-bill corrections, narrowed-policy dispatch and immutable correction evidence; staging check; [funding.md](funding.md) |
| Luna request contract, bounded context, exact-input HTTP preflight, decision provider, funded crash recovery | Verified offline with a mock transport | `LunaPreset.test.ts`, `LunaContext.test.ts`, `LunaProvider.test.ts` |
| Sponsored attempt mode in the API and UI | Verified offline with a mock transport; browser pass against the local mock | `SponsoredMode.test.ts` |
| Any call to a real provider from the game server | **Open — never made; startup still refuses paid AI** | owner authorization |
| Real provider calls from the evaluation harness | One owner-funded live attempt of the sequential Luna preset (October 7, 2026), and one owner-authorized ten-attempt run of the Haiku preset (October 9, 2026) that met all three targets. None for the concurrent Luna preset | [evaluation.md](evaluation.md) |
| Second opponent preset (`claude-haiku-5-5`): pinned request, worst-case reservation, billed refusal/truncation, SDK transport with no retries, preset pinning | Verified offline against a stand-in endpoint; a mock game run in the hardened container with networking disabled. The live API accepted the exact request in the October 9 baseline. **Not shown: how well the model plays** | `HaikuPreset.test.ts`; `scripts/evaluate-in-container.sh`; [haiku-preset.md](haiku-preset.md) |
| Local Ollama opponents for hosted rooms | Contract-tested against a stand-in server. **No real model run** | `OllamaProvider.test.ts`; [local-ai.md](local-ai.md) |
| Evaluation harness: pinned manifest, durable phase timing/recovery evidence, ledger reconciliation | Verified offline, including SIGKILL at acceptance/recovery/commit, backup/restore and expired-attempt refusal | `Evaluation.test.ts`; [evaluation.md](evaluation.md) |
| Quality, latency and cost targets (mean attempt under USD 1, phase p95 under 30 s, under 5 % unusable calls) | **Open — missed.** One live attempt of the sequential preset (October 7, 2026): cost passed, latency and unusable calls missed; one attempt is indicative only. The concurrent preset is unmeasured live and needs the owner's authorized evaluation | DIC-68 |
| End-to-end verification with the funded path | **Open** | DIC-70 |
| Real sign-in, desktop and mobile smoke test on the deployed origin | **Open — needs a deployment** | DIC-72 |
| Human review of repository history before publication | **Open** | DIC-72 |
| Approved public scenario catalog and "daily" label | **Open — owner decision** | DIC-72 |
| Production funding, paid enablement, deployment, DNS, personal-site link | **Open — owner decisions** | DIC-72 |

Update this table when a row changes; do not mark a row verified on the
strength of code existing.

## Manual browser passes recorded so far

All against a local server with a scratch database and locally seeded test
sessions; none used real sign-in or a real provider.

| Pass | What was checked |
| -- | -- |
| Guest, desktop and 375 px | guide copy uses server limits; replay steps to the end and returns; no horizontal overflow |
| Signed-in replay isolation | a chosen order survives opening and leaving the reference replay |
| Account deletion | confirm step, sign-out, history cleared, API returns 401 |
| Operator view | tiles, spectator map, stop, ban, paid switch, audit list; 375 px without overflow |
| Rotation | the day's featured scenario played to "Objective complete · Early capture" |
| Mock sponsored attempt | second start button, mode badge and label, opponents moved after one turn |
