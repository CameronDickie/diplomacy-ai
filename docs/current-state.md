# Current state — October 6, 2026

A dated snapshot. For live status use Linear
([tracking pointer](public-showcase-tracking.md)); for behaviour use the pages
listed in [README.md](README.md).

## Built and tested

| Area | Behaviour | Where |
| -- | -- | -- |
| Rules | Godip v0.6.5 adjudicates orders, retreats and builds through a bounded, cancellable executable | `engine/`, `server/src/adjudication` |
| Scenarios | Versioned JSON boards and scenarios with deterministic success and failure witnesses | [board-fixtures.md](board-fixtures.md) |
| Rotation | Six pinned development scenarios, one featured per UTC day; attempts stay pinned | [first-challenge.md](first-challenge.md) |
| Public page | Goal, rules, limits and privacy text; sanitized reference replay; no account needed | `client/src/ui/ChallengeApp.tsx` |
| Sign-in | GitHub (PKCE) and Google (signed OIDC), opaque revocable sessions, no linking by email | [authentication.md](authentication.md) |
| Owned play | Start, resume, legal-order menus, submit, idempotent retries, settled-Fall scoring, phase history | [attempts.md](attempts.md) |
| Durability | SQLite authority, checksummed migrations, frozen phase jobs, crash recovery, protected backup and restore | [storage.md](storage.md) |
| Limits | Global, per-account and daily quotas in the admission transaction; idle expiry; per-route rate buckets | [limits.md](limits.md) |
| Retention | Results 30 days, diagnostics 7 days, session and counter pruning; account deletion | [storage.md](storage.md) |
| Operator | Overview, spectator view, paid stop switch, attempt stop, account ban, audit trail, notification outbox | [operator.md](operator.md) |
| Practice bot | Free deterministic opponents as their own pinned mode (`BOT`); legal by construction, reproducible per attempt | [attempts.md](attempts.md) |
| Bot exhibition games | Background bot-only games with pause/resume/cancel, draw and limit rules; public viewing | [operator.md](operator.md) |
| Sponsored mode (mock only) | Pinned per-attempt mode, typed refusals, waiting notices, recovery; playable locally with `DIPLOMACY_LUNA_TRANSPORT=mock` | [attempts.md](attempts.md), [luna-context.md](luna-context.md) |
| Second opponent preset | `claude-haiku-5-5` behind the same ledger and recovery, selected per deployment and pinned per attempt; a locked-down container wrapper for evaluations. One live baseline of ten attempts met all three targets; play quality is unjudged and it is not enabled for players | [haiku-preset.md](haiku-preset.md) |
| Provider accounting | Every provider call recorded before its output is interpreted; late bills reconcile | [provider-accounting.md](provider-accounting.md) |
| Funding ledger | Explicit grants, atomic worst-case reservations, exactly-once settlement, typed exhaustion that pauses paid play | [funding.md](funding.md) |
| Local AI for hosted rooms | Optional Ollama opponents for clone owners: server-configured endpoint, model allowlist, capability check, no key or paid switch; refused in showcase. Contract-tested against a stand-in server only, not against a real model | [local-ai.md](local-ai.md) |
| Packaging | Non-root container with source and notices; CI on Linux and macOS | [deployment.md](deployment.md), [build-baseline.md](build-baseline.md) |

## Not built

| Gap | Consequence | Linear |
| -- | -- | -- |
| Live Luna opponents | The request contract, bounded context, decision provider, recovery and sponsored attempt mode are built and tested against a mock transport only. The server still refuses to start with paid AI enabled, so on any deployment the opponents are the practice bot or holding units | owner authorization, then DIC-68 |
| Quality, latency and cost that meet the targets | One live attempt of the sequential preset (October 7, 2026) passed the cost target and missed the latency and unusable-call targets: a no-go. The concurrent preset built in response (`luna-challenge-v2`, up to six decisions in flight) has mock evidence only and needs a new owner-authorized live sample | [evaluation.md](evaluation.md), DIC-68 |
| End-to-end release verification and runbook exercise | Not release-ready | DIC-70, DIC-72 |
| Approved public catalog | The rotation is test content and is not labelled daily | owner decision |

## Evidence and its limits

All verification so far is offline: unit and HTTP tests with mocked providers
and a mocked mail adapter, plus browser passes against a local server using a
locally seeded test session. There have been no paid provider calls, no live
notification emails beyond the one setup email recorded in Linear, and no
deployment. Real-provider sign-in was verified once on localhost for both
providers; later browser passes did not repeat it.

`npm run check` is the single local gate. CI runs it on Ubuntu with Node 22 and
Go 1.23 and on macOS with Node 26 and Go 1.27, and builds the production image.

## Set up another computer

```bash
git clone git@github.com:CameronDickie/diplomacy-ai.git
cd diplomacy-ai
npm ci
npm run check
npm run dev
```

No `.env` is required. Secrets, Terraform state and build output are not part of
the checkout. See the repository README for the URLs.

## Repository history note

Before the first push the generated Terraform provider cache was removed from
every commit; commit hashes from the first infrastructure commit onward changed.
On October 6, 2026 an automated pattern scan of tracked files and of every line
ever added in history (provider, GitHub, Google, Resend, AWS and Discord token
shapes and private-key headers) found no matches; the only environment-style
files ever tracked are `.env.example` and `terraform.tfvars.example`, and
tracked email addresses are placeholders. That is a pattern scan, not a
guarantee: a human review of history before making the repository public is
still part of the release gate (DIC-72).
