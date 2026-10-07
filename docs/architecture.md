# Architecture

Two applications share one server process, one rules engine and one map:

- the **scenario game** (`/challenge`, and `/` in the showcase profile): HTTP
  API, signed-in players, SQLite as the authority. This is the product.
- the **legacy room game** (`/` in the local profile): Socket.IO rooms held in
  memory, used for local development with offline bots. It is disabled in the
  showcase profile. The sections from "Ownership Boundaries" onward describe it.

## Scenario game

```text
browser ──HTTP──▶ httpBoundary (origin checks, no-store)
                    ├─ /api/auth      AuthService        sign-in, sessions, operator role
                    ├─ /api/operator  OperatorService    overview, spectate, stop/ban, paid switch
                    └─ /api           ChallengeService   catalog, replay, attempts, account
                                         │  RateLimiter (address, then account)
                                         ▼
                                   AttemptService ── PhaseRules ──▶ Go engine (Godip)
                                         │                └─ DecisionProvider (hold-only today)
                                         ▼
                                   Store ──worker thread──▶ SQLite (WAL)
Notifier ◀── outbox table                       ▲
                                    retention sweep (hourly)
```

Rules that shape the code:

- **SQLite is the authority.** The browser holds no game state it can assert.
  Every write happens in one `BEGIN IMMEDIATE` transaction on a worker thread;
  in-memory promises only coalesce work and carry cancellation.
- **A phase is a durable job.** Accepting orders freezes the board, definition
  and action into `phase_jobs`. Deciding, resolving and committing each check a
  fence (operation, attempt, phase, revision), so a late or duplicate result
  cannot commit and a crash resumes from the frozen inputs.
- **Requests are idempotent by request ID.** A repeated start or submission
  returns the original result and consumes nothing.
- **Public output is projected, not filtered.** `storage/publicData.ts` copies
  named fields into public shapes; anything not named is absent.
- **Opponent decisions come through one seam.** `DecisionProvider` receives a
  frozen copy of the job and returns decisions; it cannot commit. Today it
  returns legal holds. The funded `gpt-6-luna` adapter will plug in here.
- **Provider calls are recorded before they are interpreted**, and every
  `prepare`/`dispatch` re-checks that the attempt is active, the player is not
  banned, the fence is current and the paid switch is not stopped.
- **Scoring reads server-recorded Fall reports only**, after retreats settle.

### Code map

| Path | Responsibility |
| -- | -- |
| `config/runtime.cjs` | validated settings, profiles, paid-startup interlock |
| `server/src/index.ts` | process wiring, HTTP and socket servers, shutdown |
| `server/src/auth.ts`, `auth/` | OAuth flows, sessions, origin checks, operator role, socket policy |
| `server/src/challenge/ChallengeService.ts` | public catalog and replay, attempt routes, account deletion, idle and retention sweeps |
| `server/src/challenge/Catalog.ts` | rotation manifest and the featured-by-UTC-day function |
| `server/src/challenge/TunisPilot.ts` | challenge definition type and the scorer |
| `server/src/attempts/` | `AttemptService` (phase lifecycle), `PhaseRules` (legal orders, validation, resolution), action parsing |
| `server/src/storage/Store.ts`, `worker.ts` | typed RPC to the SQLite worker; every operation |
| `server/src/storage/migrations.ts` | append-only, checksummed schema |
| `server/src/storage/phases.ts` | phase job fences and commit |
| `server/src/storage/providerCalls.ts` | provider call ledger |
| `server/src/storage/retention.ts` | cleanup and account deletion |
| `server/src/storage/operator.ts`, `outbox.ts` | operator views, paid switch, audit, notifications |
| `server/src/storage/publicData.ts` | public projections and challenge parsing |
| `server/src/operator/` | operator routes and the notification sender |
| `server/src/limits/RateLimiter.ts` | rate buckets and client address policy |
| `server/src/providers/` | provider accounting and the Luna request contract |
| `server/src/fixtures/` | board and scenario import/export, witnesses, CLI |
| `server/fixtures/` | development scenarios and the rotation manifest |
| `server/src/adjudication/` | bounded executor for the Go engine |
| `server/src/GameRoom.ts`, `handlers/`, `llm/`, `discord/` | legacy room game and optional integrations |
| `client/src/ui/ChallengeApp.tsx`, `OperatorPanel.tsx` | scenario page and operator view |
| `client/src/hooks/useChallenge.ts`, `useAuth.tsx` | client state for the scenario flow |
| `shared/src/types/challenge.ts`, `operator.ts`, `history.ts` | wire types |
| `engine/` | Go wrapper around Godip; `cmd/generate-board` produces adjacency data |

Tests live in `server/src/test`; each area above has a matching file, and
`AccessMatrix.test.ts` fails if an API route is added without an access class.

## Legacy room game

## Ownership Boundaries

`client/` displays public game state and submits player intent. It is not trusted
to validate ownership or legality.

`server/` owns rooms, player identity, authorization, phase orchestration, and
future persistence, press, deadlines, and model calls. Socket IDs are transient
transport details and never appear in `GameState`.

`shared/` contains public contracts and presentation-oriented board metadata. It
does not adjudicate orders.

`engine/` wraps Godip in a small JSON-over-stdio executable. The Node adapter
translates the application model to the engine model and maps results back while
preserving stable unit IDs.

## Rules

Godip `v0.6.5` is the authoritative movement adjudicator. This replaces the
prototype resolver, which mishandled equal attacks, head-to-head swaps, circular
movement, convoy edge cases, and retreat legality.

The next rules milestone is to send retreats and adjustments through the same
adapter. Until then, the server validates ownership and permitted destinations
before applying those phases.

## Map

The client loads a structured SVG whose province, supply-center, coast, unit, and
order layers have stable IDs. React state colors province geometry and creates
unit markers at the SVG's existing province-center anchors.

No territory coordinates are hand-authored in application code. Client
adjacency hints are generated by `engine/cmd/generate-board` directly from
Godip's classical graph and committed as deterministic TypeScript.

## Sessions

Human players receive a random opaque session token. The server stores only its
SHA-256 hash and maps it to the stable player ID and current socket. A browser can
resume the seat after a reconnect while the server process remains alive.

Persisting rooms and token hashes in SQLite is required before internet hosting;
the current in-memory store loses games on process restart.

## LLM Controllers

LLM powers use the same order, retreat, and build commands as humans. Providers
must return structured intent, which is validated by the server and adjudicated
by the rules engine. Provider prompts and responses should be stored as private
turn artifacts, separate from public game state.

Prompts use a versioned canonical board context generated from the same
territory graph used by the application. It explicitly separates supply-center
ownership, original home power, current occupation, and pending Fall captures.
For movement decisions, the Go engine flattens Godip's legal options into stable
order IDs. A model selects one ID per active unit or a supplied candidate set;
it does not construct free-form movement orders. Tactical suggestions and
automated-order validation consume that same catalog.

Turn-start planning is scheduled when an orders phase begins. A host-configured
number of rotating provider-backed LLM powers may use a cheaper role-specific
planner model to choose a relevant human or LLM recipient and open a private
conversation. Human-targeted outreach is delivered as a normal private message
and tracked server-side as replied, ignored, or expired. LLM-to-LLM openings use
the existing bounded conversation loop. Final automated phase decisions still
run after all active human powers submit, ensuring the latest private
negotiations and ignored outreach outcomes are included. Invalid provider output
is retried with validation feedback up to the configured retry limit and then
replaced by a deterministic fallback so a provider outage cannot stall the game.

Each structured opening and reply states whether another answer is required.
The server alternates speakers only while that flag remains true, warns models
at a configurable message count, and always terminates at a hard message cap.
This gives automated powers initiative without allowing autonomous messages to
delay the phase indefinitely.

Each LLM has one power-scoped memory containing its private transcript, concise
strategic summary, and structured agreement ledger. Incoming messages are
serialized per power before replies and memory updates are generated. LLM
conversations are also serialized across the room so two live automated
exchanges cannot overlap. Presence is server-owned: participants see the exact
pair, uninvolved players see only generic automated activity unless the host
enabled public pairings before the game.

Every provider call creates a private structured run artifact with context
message IDs, memory revisions, board snapshot, decision, validation/fallback
metadata, board-context version, legal-order count, selected legal IDs, and
lifecycle statuses. These artifacts intentionally exclude hidden chain-of-
thought. They remain server-private until observer/research roles and their
authorization rules are implemented. Each completed run also emits a concise
host-only outcome summary with game-level run, retry, and fallback counters;
the event excludes prompts, private messages, memory, and structured decisions.

The current provider implementations are the deterministic stub, OpenAI
structured output, and Gemini structured output. Provider and model selection is
resolved through server-owned role defaults, allowlists, timeouts, retry limits,
output-token limits, and per-game estimated spend caps before any paid request
is made.

An all-LLM room can resolve its opening phase without a human submission, but
continuous simulation requires a separate background game runner. That runner
must persist checkpoints, enforce turn and spend limits, support pause/resume,
recover provider failures, detect repeated or stagnant states, and avoid
holding a socket request open for the lifetime of a game.

## Public History and Replay

The server records an immutable public report after every orders, retreats, and
adjustments phase. Each report contains before/after board snapshots and the
public decisions and outcomes needed to explain the resolution. Reports are
sent on reconnect and streamed as phases resolve.

The client timeline and replay renderer consume only these reports. Replay
never mutates live game state: it renders the stored pre-resolution snapshot,
decision layer, and resolved snapshot with movement interpolation and
outcome-specific styling. Public JSON export uses the same schema and excludes
private press, LLM journals, session tokens, and provider credentials.

Reports currently live in memory. Durable restart recovery and long-running
all-LLM studies require the persistence layer planned for deployment work.

## Discord Transport

Discord is an optional transport over the same authoritative room and
diplomacy service used by Socket.IO. One coordinator bot handles a single
guild's game binding and short-lived account-link codes. Seven separately
authenticated power bots provide distinct DM and voice identities.

Discord DMs are converted into canonical diplomatic messages with source and
external-message metadata. The application service validates and deduplicates
them before `GameRoom` updates private history and LLM memory. Browser clients
receive the same messages through their existing socket stream.

Voice sessions use temporary private channels and an explicit-turn state
machine controlled from the browser. Discord Opus is decoded and converted to
24 kHz mono PCM for an OpenAI Realtime server WebSocket; returned PCM is
converted to Discord's 48 kHz stereo stream. Final transcripts are canonical
messages and raw audio is discarded. A room-wide voice lock stores incoming
text immediately while delaying generated responses and autonomous diplomacy
until voice ends.

Discord integration and voice are independently configurable. All binding and
session state remains in memory until the persistence deployment milestone.
