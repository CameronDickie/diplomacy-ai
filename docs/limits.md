# Request limits and proxy trust

Two layers bound what a visitor or account can make the server do.

## Durable quotas (SQLite, survive restart)

Enforced inside the admission transaction and described in `docs/attempts.md`:
active attempts globally (`DIPLOMACY_MAX_ACTIVE_ATTEMPTS`), per account
(`DIPLOMACY_MAX_ACTIVE_PER_ACCOUNT`) and accepted starts per account per UTC day
(`DIPLOMACY_DAILY_START_LIMIT`). A duplicate start request ID returns the
original attempt and consumes nothing. There is no waiting room: a full site
answers `409 CAPACITY_FULL`.

## Hosted games (memory)

Games with friends or practice bots are held in memory: at most
`DIPLOMACY_MAX_ROOMS` at once, and in the showcase profile at most
`DIPLOMACY_MAX_ROOMS_PER_ACCOUNT` unfinished games hosted per account. At a
cap, finished games and games with nobody connected are given up first; then
creation is refused with `SERVER_FULL` or `HOSTING_LIMIT`.

## Short-window rate buckets (memory)

`server/src/limits/RateLimiter.ts` applies fixed one-minute windows per route
category. The address bucket runs before authentication, the account bucket
after it, so a new cookie, session or connection does not reset an account's
bucket and an unauthenticated flood is bounded too.

| Category | Routes | Per account | Per address |
| -- | -- | -- | -- |
| `public` | catalog, reference replay | — | 120 |
| `read` | attempt list, attempt, reports | 240 | 600 |
| `legal` | legal-order catalog (runs the rules engine) | 30 | 120 |
| `command` | orders, activity, recover, abandon | 30 | 120 |
| `start` | start attempt | 10 | 30 |
| `account` | credit request, account deletion | 5 | 20 |
| `operator` | every `/api/operator` route | 120 | 240 |

| `room` | hosted game: create, join, resume, seat, settings, start | 20 | 60 |

A hosted game's socket events use the same buckets (`SOCKET_RATE`): setting up
a game is `room`, its legal orders are `legal`, orders and messages are
`command`, history and state are `read`. The address bucket runs before the
session is resolved and the account bucket after, shared by every connection,
and a refused event gets `RATE_LIMITED` and does no work.

A refused request gets `429` with `Retry-After` and
`{"code":"RATE_LIMITED","retryAfterSeconds":n}`; it does no storage, engine or
provider work. The table holds at most 20,000 live keys and refuses new keys
rather than grow. These buckets reset on restart by design; the durable quotas
above do not. Request bodies are capped at 64 KB.

Sign-in has its own limits in `docs/authentication.md`. Provider concurrency
and provider queue bounds belong to the funded adapter (DIC-60/66); the store
already re-checks attempt state, ban, fence and the paid switch on every
provider `prepare` and `dispatch`.

## Whose address is it?

`DIPLOMACY_TRUSTED_PROXY` decides:

- `none` (default): the direct TCP peer. `X-Forwarded-For` is ignored, so it
  cannot be forged. Behind a reverse proxy every visitor then shares the proxy's
  address and the address buckets become one shared ceiling.
- `private`: only when the direct peer is loopback or a private-network address,
  the **right-most** `X-Forwarded-For` entry is used — the one that proxy
  appended. Entries to its left are client-supplied and ignored, and a public
  peer sending the header is never believed.

Set `private` only where the app port is unreachable except through your own
proxy. `docker-compose.lightsail.yml` does this: the app is `expose`d to Caddy on
the compose network and never published. Origin validation and authorization
are separate checks and do not depend on this setting or on CORS.
