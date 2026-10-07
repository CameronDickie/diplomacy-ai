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
| Provider accounting | Every provider call recorded before its output is interpreted; late bills reconcile | [provider-accounting.md](provider-accounting.md) |
| Packaging | Non-root container with source and notices; CI on Linux and macOS | [deployment.md](deployment.md), [build-baseline.md](build-baseline.md) |

## Not built

| Gap | Consequence | Linear |
| -- | -- | -- |
| Budget reservation and exhaustion | No paid call can be authorized; the server refuses to start with paid AI enabled | DIC-64 |
| Luna adapter, bounded prompts, funded recovery | Opponents hold every turn in practice mode | DIC-66, DIC-67, DIC-60 |
| Sponsored attempt mode | Every attempt is `PRACTICE` | DIC-54 |
| Usage-receipt pruning | `provider_calls` is kept indefinitely until a cumulative ledger exists | DIC-62 with DIC-64 |
| Quality, latency and cost measurement | No evidence that Luna opponents are fair, fast or affordable | DIC-68 |
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
