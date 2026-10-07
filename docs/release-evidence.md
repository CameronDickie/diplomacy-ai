# Release evidence

A requirement-by-requirement record of what has been verified and how. "Offline"
means automated tests with mocked providers and mail, or a local server or
container using locally seeded test sessions. Nothing here is evidence from a
deployed site, a paid provider call or a live notification email, because none
has happened.

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
| Provider calls recorded before interpretation; late bills reconcile | Verified offline | `ProviderAccounting.test.ts` |
| Paid stop, attempt stop, ban; enforcement at dispatch | Verified offline | `Operator.test.ts`, browser pass of the operator view |
| Notifications once per event, retry, no blocking of play | Verified offline with a mocked mail adapter | `Operator.test.ts` |
| Backup, restart and restore preserve identity, attempts, reports, spend, unresolved liability | Verified in a local container | `scripts/staging-check.sh` |
| Rollback | Procedure documented; older-image refusal covered by migration-mismatch tests | [deployment.md](deployment.md), `Store.test.ts` |
| Budget ledger: grants, reservations, per-attempt and total caps, exhaustion, crash safety | Verified offline with synthetic amounts | `Funding.test.ts`, staging check; [funding.md](funding.md) |
| Luna request contract, bounded context, decision provider, funded crash recovery | Verified offline with a mock transport | `LunaPreset.test.ts`, `LunaContext.test.ts`, `LunaProvider.test.ts` |
| Sponsored attempt mode in the API and UI | Verified offline with a mock transport; browser pass against the local mock | `SponsoredMode.test.ts` |
| Any call to the real provider | **Open — never made; startup still refuses paid AI** | owner authorization |
| Quality, latency and cost targets (mean attempt under USD 1, phase p95 under 30 s) | **Open — needs an authorized paid evaluation** | DIC-68 |
| End-to-end verification with the funded path | **Open** | DIC-70 |
| Real sign-in, desktop and mobile smoke test on the deployed origin | **Open — needs a deployment** | DIC-72 |
| Human review of repository history before publication | **Open** | DIC-72 |
| Approved public scenario catalog and "daily" label | **Open — owner decision** | DIC-72 |
| Production funding, paid enablement, deployment, DNS, personal-site link | **Open — owner decisions** | DIC-72 |

Update this table when a row changes; do not mark a row verified on the
strength of code existing.
