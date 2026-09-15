# Code review and repair backlog

Reviewed September 14, 2026. This is the working checklist for the whole-codebase
review, not a claim that every item has been implemented.

## Working agreement

- Prioritize a reliable browser game; voice and Discord are optional, deferred work.
- Preserve the existing rules engine, generated adjacency, private press boundaries,
  and public phase reports.
- Check off work only after implementation and appropriate verification. Record
  partial progress separately; do not mark a parent item complete prematurely.
- Keep each session at a coherent, tested stopping point. Do not deploy or spend
  money on provider calls as part of local verification.
- Ask about material product choices when implementation reaches them (deadline
  defaults, disconnected-seat replacement, draw rules, and persistence retention).

## Baseline

The production build, 49 server tests, and 10 Go tests passed during review.
Review included local reproductions but no live Discord, paid provider, or browser
rendering validation. The strongest foundations are server ownership checks,
Godip adjudication, generated board topology, and public replay reports. The
largest weaknesses are concurrency, command boundaries, and restart recovery.

## First: core game correctness and recovery

### R1 — Validate incoming commands (high)

Malformed Socket.IO payloads can throw before handler error handling. Reproduced:
`create_game({ playerName: 42 })`. Build validation also accepted an unknown unit
type. TypeScript interfaces do not validate network data.

- [x] Validate all incoming event shapes, nested values, enums, and size bounds.
- [x] Catch synchronous exceptions and asynchronous rejections at handler entry.
- [x] Regression-test malformed commands without changing game state.
- [x] Harden malformed authentication cookies and login payload handling.

Sources: `server/src/handlers/`, `server/src/auth.ts`, `server/src/GameRoom.ts`.

### R6 — Enforce one seat per socket (high)

Joining/resuming can associate one socket with multiple seats or rooms, while
authorization resolves only the first seat. Reproduced with England and France.

- [x] Reject joining another seat or room while already attached.
- [x] Make resuming the same seat safe; reject resuming a different seat.
- [x] Detach the old transport on a valid seat takeover and notify its browser.
- [x] Test duplicate joins, cross-room joins, takeover, and disconnect behavior.

Sources: `server/src/handlers/gameHandler.ts`, `server/src/GameRoom.ts`.

### R5 — Fence submissions to a phase (high)

Submissions carry no year/season/revision. Replaying one command can advance a
later phase; reproduced with the same empty orders advancing Spring and Fall.

- [x] Include a server-verifiable phase ID on orders, retreats, and builds.
- [x] Reject stale submissions and resynchronize the client.
- [ ] Add request IDs and idempotent receipts, including across reconnects.
- [x] Test delayed and duplicated commands across phase boundaries.

Sources: `shared/src/types/socket.ts`, order handlers, game socket hook.

### R15 — Show errors to every player

Join and command errors only enter the event log, which is host-only. An invalid
join code can look like an unresponsive button.

- [x] Show actionable errors independently of host diagnostics.
- [x] Keep failed joins from replacing the active game ID.
- [ ] Verify non-host and pre-join error visibility.

Sources: `client/src/hooks/useGameSocket.ts`, `client/src/ui/App.tsx`.

### R16 — Acknowledge submissions and recover failures

Retreat/build buttons claim submission before acceptance, then cannot recover
from rejection. Movement rollback changes server state without broadcasting it.

- [ ] Model editing/submitting/accepted/failed for all three phase types.
- [ ] Restore accepted submission state on reconnect.
- [x] Broadcast authoritative state after movement-submission rollback; allow retries.
- [ ] Test failed adjudication, rejected builds/retreats, and reconnects.

Sources: `OrderPanel.tsx`, order handlers, `GameRoom.ts`.

### R17 — Derive human orders from engine legality

Map moves reject friendly-occupied destinations even when simultaneous movement
can make them legal. Support menus omit convoyed movement, target coast menus
include unreachable coasts, and map convoy discovery excludes allied fleets.

- [ ] Expose the human power's authoritative legal-order catalog.
- [ ] Use it for moves, support, convoys, and destination coasts.
- [ ] Allow friendly destinations and cooperative convoys without issuing orders
  for another player's units.
- [ ] Test rotations, convoy support, split coasts, and cooperative convoy entry.

Sources: `App.tsx`, `OrderPanel.tsx`, `client/src/lib/game.ts`, Godip adapter.

### R18 — Make chat delivery truthful and idempotent

Optimistic messages look delivered after rejection; the composer discards the
draft. Browser message IDs are not deduplicated like external transport IDs.

- [ ] Track pending/delivered/failed messages and preserve retryable drafts.
- [ ] Deduplicate browser request IDs on the server.
- [ ] Distinguish rejection from stored-message/reply-generation failure.
- [ ] Test retries and reconnect reconciliation without duplicate AI replies.

Sources: game socket hook, `DiplomacyService.ts`, diplomacy handlers.

### R7 — Persist games before relying on deployment (high)

Every restart loses games, pending commands, session hashes, press, and history.
Deployment forcibly recreates the app container; the `/data` mount is unused.

- [ ] Persist room state, accepted commands, session hashes, and private/public
  history with transactional phase transitions.
- [ ] Recover interrupted resolution without resolving a phase twice.
- [ ] Persist transport links when optional integrations are revisited.
- [ ] Test restart recovery, migrations, backup/restore, and deployment behavior.

Sources: `GameManager.ts`, `GameRoom.ts`, compose and deployment script.

### R4 — Coordinate negotiations with resolution (high)

Order generation ignores active human-initiated press and voice reconciliation.
A phase advanced while a voice lock was active in a local reproduction. Concurrent
AI work can apply stale memory after newer work.

- [ ] Define negotiation cutoff and drain/cancel relevant pending text work.
- [ ] Generate decisions from immutable phase snapshots.
- [ ] Serialize or revision-check every per-power memory update.
- [ ] Test late text replies during submission and phase changes.
- [ ] Later: include voice and voice reconciliation in the same lifecycle.

Sources: `GameRoom.ts` phase completion and AI scheduling methods.

## Next: operations, AI, and maintainability

### R8 — Preserve production AI configuration (high)

The environment renderer drops `GEMINI_API_KEY` and all `LLM_*` settings, including
spend caps, provider/model restrictions, retries, and role defaults.

- [ ] Share a runtime configuration schema with deployment rendering.
- [ ] Preserve every supported variable and test a full round trip.
- [ ] Validate optional integrations only when enabled.

Source: `scripts/render-production-env.cjs`.

### R20 — Account for all AI spending

Only successfully validated calls record usage. Rejected/invalid responses can
cost money without accounting; concurrent requests do not reserve budget; audio
usage is excluded.

- [ ] Record usage for every attempt, including invalid output and retries.
- [ ] Reserve estimated budget before concurrent requests.
- [ ] Make unknown pricing visible and define its spending behavior.
- [ ] Later: add explicit realtime audio budgets and accounting.
- [ ] Test limits using mocked providers, with no paid calls.

Sources: `GameRoom.ts`, provider adapters, `llm/policy.ts`.

### Q1 — Make game pacing and completion explicit

- [ ] Define negotiation/submission/resolution/recovery states.
- [ ] Add configurable deadlines and pause/resume.
- [ ] Decide and implement disconnected-player and abandoned-host behavior.
- [ ] Define draw and end-game flow.
- [ ] Add a bounded background runner for games with no active humans.

### Q2 — Separate ownership and responsibilities

- [ ] Extract sessions, phase orchestration, diplomacy, AI scheduling, and history
  from the roughly 2,270-line `GameRoom` after regression coverage is in place.
- [ ] Replace externally mutable `getState()` access with snapshots/read-only views
  and explicit state-changing commands.
- [ ] Audit detached promises, including discarded `finally()` return promises.

### Q3 — Keep the rules engine from blocking the server

- [ ] Replace synchronous child-process execution with asynchronous execution.
- [ ] Bound concurrency, execution time, and output; support cancellation.
- [ ] Test that a slow/hung engine does not block other rooms or health checks.

Source: `server/src/adjudication/GodipAdjudicator.ts`.

### Q4 — Bound memory and prompt growth

- [ ] Expire abandoned rooms and prune caches/deduplication records.
- [ ] Bound/paginate histories and AI artifacts while retaining durable archives.
- [ ] Limit prompt transcript growth using summaries and a recent-message window.

### Q5 — Expand verification at system boundaries

- [x] Include Go tests in `npm run check`.
- [x] Add malformed-event, duplicate-seat/takeover, and stale-phase regression coverage.
- [ ] Add overlapping negotiation/resolution and provisioning race coverage.
- [ ] Add browser tests for orders, submission failures, chat, and reconnects.
- [ ] Add restart/deployment and mocked-provider contract tests.
- [ ] Later: add voice lifecycle and multiple-bot integration coverage.

## Later: optional voice and Discord

### R2 — Isolate bot voice connections (high when voice is enabled)

Different bots share the default connection group and guild key. Two local joins
returned the same connection object.

- [ ] Use one connection group per bot identity.
- [ ] Test simultaneous calls, playback, and independent teardown.

### R3 — Remove voice/negotiation deadlock (high when voice is enabled)

Voice installs a lock before waiting for a conversation; the conversation's next
reply can wait on that lock. Reproduced locally before provisioning/timers exist.

- [ ] Establish one lock acquisition order and cancellable queued provisioning.
- [ ] Test voice starting during multi-message negotiations.

### R9 — Recover from failed voice provisioning

`FAILED` with no session ID enables neither Start nor End and can hide the error.

- [ ] Show provisioning errors and a retry action without requiring a session ID.
- [ ] Test cleanup and successful retry after each provisioning failure.

### R10 — Reserve voice participants before asynchronous work

- [ ] Reserve both participants before the first await.
- [ ] Release reservations on all failures and cancel provisioning on End.
- [ ] Test simultaneous human/human and human/AI requests.

### R11 — Ground voice in the current board

- [ ] Supply canonical board/phase context, not just persona and private history.
- [ ] Refresh or end voice when the phase changes.

### R12 — Correct the audio lifecycle

- [ ] Separate generation completion, playback drain, and memory reconciliation.
- [ ] Refresh inactivity from actual speech/playback activity.
- [ ] Resume auto-listening after responses when enabled.
- [ ] Track cancelled response IDs instead of one ignore-next boolean.
- [ ] Bound connection setup and handle closed/failed sessions with cleanup.

### R13 — Delete only channels owned by the application

Cleanup currently deletes every empty voice channel named `diplomacy-*`.

- [ ] Track exact owned channel IDs and exclude active/provisioning sessions.
- [ ] Test unrelated channels and restart cleanup.

### R14 — Contain Discord errors and report actual readiness

- [ ] Catch all listener promise rejections, including reply/typing failures.
- [ ] Make error reporting best-effort.
- [ ] Report connection readiness instead of configured-token presence.

### R19 — Reduce voice-driven browser work

Audio packets trigger state/log updates, application rerenders, and map layer
replacement; unrelated updates can also disrupt keyboard focus.

- [ ] Throttle diagnostics and log status transitions instead of packets.
- [ ] Stabilize callbacks and update map layers independently.
- [ ] Verify render behavior and keyboard focus during activity.

## Implementation log

### September 14, 2026 — First repair session

Implemented the first core-game repair batch:

- Added an exhaustive validator registry and shared error boundary for every
  client event. Optional integration handlers use the same boundary; their voice
  and Discord behavior has not otherwise been repaired.
- Added malformed-cookie handling (percent decoding and multibyte signatures)
  and safe handling of null login bodies.
- Enforced unique socket seats. Existing valid session tokens retain takeover
  behavior: the new tab takes control, the old tab leaves room broadcasts and is
  notified. The old tab does not erase the new tab's shared local-storage token.
- Added phase IDs to all three submission events, stale-command rejection and
  state synchronization. Old browser bundles must refresh before submitting.
  Request receipts and same-phase idempotency are still open.
- Added dismissible player-visible errors, preserved the active game ID after a
  failed join, and cleared stale game state after an invalid/missing saved game.
- Broadcast movement rollback so the current client can unlock and retry.
- Added Go tests to the normal verification command.

Verification: production build passed; 61 server tests (12 new) and all 10 Go
tests passed. The sandbox prevents Node's Go subprocess checks from completing
normally; the same local suites passed outside that restriction. No live services,
paid provider calls, deployments, or source-control commits were made. Browser
rendering/interaction has not been exercised, so the explicit UI verification task
under R15 remains open.

Next coherent batch: complete R5/R16 with request receipts, authoritative submission
state and retry/reconnect behavior; then address human legal-order menus (R17).
Persistence remains a high-priority milestone before relying on long-running games.
