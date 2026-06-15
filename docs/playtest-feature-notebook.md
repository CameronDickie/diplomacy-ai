# Playtest Feature Notebook

This document turns playtest observations into independent implementation
workstreams. Each workstream should be small enough to design, implement, test,
and review without requiring the others to ship at the same time.

## Guiding Constraints

- Keep the game usable as a single-page application. The browser page itself
  should not become the primary scroll container.
- Keep authoritative rules state separate from presentation state.
- Public turn outcomes must be understandable without exposing private press,
  private LLM memory, or hidden model reasoning.
- Do not store or display raw chain-of-thought. Store concise structured
  strategic summaries, decisions, agreements, validation errors, and model-run
  metadata instead.
- Build replay and export from a durable event timeline rather than recording
  the live DOM as the source of truth.

## Current Boundary

The playtest-facing foundation in this notebook is implemented: bounded panel
scrolling, pending supply-control markers, adjustment counts, privacy-aware
conversation presence, structured model-run artifacts, public phase history,
deterministic replay, movement/outcome visuals, and public JSON export.

The remaining items cross architectural boundaries and should follow the
infrastructure work rather than be added to the in-memory room:

- **Persistence:** restart recovery, durable reports, and long-running all-LLM
  studies need a database-backed room/event store.
- **Authorization:** an LLM journal UI or private research export needs explicit
  observer and post-game disclosure roles. A host who is also playing must not
  gain access to opponents' private context.
- **Media rendering:** standalone HTML, WebM, and MP4 need a stable archive
  version plus browser/headless rendering and resource limits.
- **Advanced animation polish:** convoy paths, support-cut choreography, and
  dislodgement-specific transitions can iterate independently on the existing
  replay contract.

## Workstream A: Bounded Single-Page Layout

**Status:** Initial desktop and responsive implementation completed.

### Problem

Long chat histories and logs increase the document height. The entire page
scrolls instead of keeping the board and controls in a stable application
shell.

### Proposed Feature

- Constrain the application to the viewport height.
- Give the player list, order panel, conversation list, active conversation,
  and event log their own scroll containers.
- Preserve the chat composer and section headers while message content scrolls.
- Ensure mobile uses deliberate stacked panels rather than unbounded document
  growth.

### Acceptance Criteria

- Desktop has no document-level vertical scrollbar during normal play.
- Chat messages can grow indefinitely without moving the board.
- The latest message remains reachable and auto-scroll does not override a
  user who is reading older messages.
- Keyboard focus and touch scrolling work inside every scroll region.

### Dependencies

None. This is the recommended first task.

## Workstream B: Pending Supply-Center Control

**Status:** Initial occupied-center ring and map legend completed.

### Problem

Supply-center ownership changes after Fall adjudication. During Spring and Fall,
the board does not clearly show which power most recently occupied a center and
would claim it if that occupancy survives through Fall.

### Proposed Feature

Display two distinct concepts:

- **Current owner:** the power that legally owns the supply center.
- **Current occupier:** the power whose unit is presently in the province.

For an occupied supply center owned by another power or neutral, add a small
occupier-colored ring, corner marker, or striped overlay. A legend should call
this “occupied” or “pending Fall control,” not “scheduled ownership,” because
the unit can still move or be displaced before Fall resolution.

### Acceptance Criteria

- Ownership color remains unchanged until the rules engine updates it.
- A differently colored occupier is visible without hiding province labels,
  units, order arrows, or supply-center symbols.
- Neutral centers and enemy-owned centers use the same visual rule.
- The marker updates immediately after adjudication and is accessible by text.

### Dependencies

No server change is required for the first version; occupiers can be derived
from public unit and territory state.

## Workstream C: Conversation Presence and Locking

**Status:** Initial server serialization and privacy-aware presence UI completed.

### Problem

Players need to know whether a power is available for a live conversation, and
the system needs an explicit rule for whether a power can participate in
multiple simultaneous exchanges.

### Proposed Feature

Add server-owned conversation presence:

- `IDLE`
- `WAITING_FOR_REPLY`
- `RESPONDING`
- `AT_MESSAGE_LIMIT`

Serialize active LLM conversations by power. If either participant is busy,
queue or reject a new autonomous conversation. Human text press should remain
asynchronous and should not be blocked merely because an LLM is processing
another response.

### Privacy Decision

Showing exact LLM pairings to every player leaks private diplomatic activity.
The recommended default is:

- Participants see the other power as responding.
- Other players see only a generic “automated diplomacy in progress” state.
- A fully public activity mode can be an explicit game setting.
- Hosts who are active players do not receive privileged pairing information.

### Acceptance Criteria

- One LLM power cannot process two diplomatic responses concurrently.
- Autonomous conversations cannot interleave messages incorrectly.
- UI presence is derived from server state, not guessed from local timers.
- Default visibility does not reveal private pairings to uninvolved players.

### Dependencies

Build on the existing per-power LLM queue and bounded conversation loop.

## Workstream D: LLM Decision Journal

**Status:** Structured in-memory journal backend completed. Active-game UI is
deferred until observer/research authorization exists.

### Problem

The event log shows model status, but there is no useful history explaining
what context a model received, what structured conclusion it retained, or why
it fell back.

### Proposed Feature

Create a private model-run journal containing:

- Power, model, provider, prompt version, phase, and purpose.
- State snapshot or stable snapshot reference.
- Conversation IDs and message IDs included in context.
- Concise `strategicSummary`.
- Structured agreements before and after the run.
- Structured decision or action output.
- Validation errors, retries, fallback reason, latency, and token usage.
- Lifecycle status such as queued, thinking, replying, deciding orders, or
  complete.

Do not request, persist, or display hidden chain-of-thought. A later observer
view can show the structured journal for LLM-only research games. Normal human
players should not receive opponents' private journals during an active game.

### Acceptance Criteria

- Every provider call has a stable run ID and context references.
- A host can diagnose fallback behavior without reading server console output.
- Private journals remain inaccessible to unauthorized players.
- Completed research games can optionally reveal or export journals.

### Dependencies

Durable event storage is strongly recommended before this becomes more than a
development-only feature.

## Workstream E: Adjustment UI State

**Status:** Remaining-count and exhausted-input behavior completed.

### Problem

The displayed adjustment count does not decrease when a build is added, and the
build editor remains visible after all available builds are allocated.

### Proposed Feature

- Display `remaining = allowed builds - queued builds`.
- Update the number immediately when adding or removing a queued build.
- Hide or disable the build inputs when `remaining` reaches zero.
- Keep a clear “waive remaining builds” action while builds remain.
- For forced disbands, show the remaining required disband count similarly.

### Acceptance Criteria

- Counts always reflect the queued adjustment draft.
- A player cannot queue more builds or disbands than allowed.
- Removing an adjustment reopens the appropriate input.
- Submit clearly distinguishes allocated, waived, and still-required actions.

### Dependencies

None for the immediate UI fix. Engine-backed adjustment legality remains a
separate rules milestone.

## Workstream F: Public Turn Report

**Status:** In-memory phase reports, reconnect delivery, and public timeline UI
completed. Durable restart recovery remains part of persistence work.

### Problem

`lastAdjudicationResult` exists, but players do not have a clear public answer
to “what happened this turn?”

### Proposed Feature

Create a public phase report with:

- Every submitted or defaulted order after the phase locks.
- Success, bounce, cut support, dislodgement, failed convoy, and standoff
  outcomes.
- Retreats, disbands, builds, waived builds, and ownership changes.
- Before and after unit positions.
- Phase and year identifiers.

Store reports as immutable phase history rather than only retaining the latest
adjudication result. Add a timeline panel that opens a selected phase report.

### Acceptance Criteria

- Every player sees identical public results after resolution.
- Private messages and model journals are not included.
- Reports survive reconnects and, after persistence work, server restarts.
- Outcome language is understandable without reading raw engine identifiers.

### Dependencies

This is the foundation for animation, replay, and video export. Implement it
before those workstreams.

## Workstream G: Turn Animation and Replay

**Status:** Initial deterministic replay completed, including playback
controls, movement interpolation, failed-order styling, standoff effects,
reduced-motion handling, and skip/close behavior. Advanced adjudication
choreography remains optional polish.

### Problem

The board jumps directly from old positions to new positions. Players cannot
easily connect orders to adjudication outcomes.

### Proposed Feature

Build a deterministic animation sequence from a stored public phase report:

1. Show submitted orders.
2. Animate successful moves.
3. Pulse bounces and standoffs.
4. Mark cut supports and failed convoys.
5. Show dislodgements and retreat requirements.
6. Apply Fall ownership changes.
7. Show builds and disbands.

Provide Replay, Pause, step-forward, speed, and Skip controls. Replay must
render from stored snapshots and events without changing live game state.

### Acceptance Criteria

- Replay produces the same final board state as the stored phase snapshot.
- Players can skip animation without delaying server progression.
- Replaying an old phase cannot alter current selection or orders.
- Reduced-motion users receive an immediate or stepped presentation.

### Dependencies

Requires Workstream F. A board snapshot before and after every phase should be
stored with the report.

## Workstream H: Video and Data Export

**Status:** Public JSON archive export completed. Standalone HTML and video
rendering are deferred until the archive schema and deployment rendering stack
are stable.

### Problem

There is no way to produce a shareable record of a game or study long-term LLM
behavior outside the live application.

### Proposed Feature

Implement exports in increasing order of complexity:

1. JSON game archive containing public snapshots and phase reports.
2. Static HTML replay that loads the archive locally.
3. Browser-rendered WebM capture of the deterministic replay.
4. Optional server-side MP4 rendering using a headless browser and FFmpeg.

Private press and model journals must be separate, opt-in export channels.
Never include API keys, session tokens, or hidden journals in the public game
archive.

### Acceptance Criteria

- Public archive reproduces the complete public game.
- Export declares whether private press or LLM journals are included.
- Video output has stable resolution, phase labels, and playback timing.
- Export failure does not affect the active game.

### Dependencies

Requires Workstreams F and G. Server-side MP4 also requires deployment tooling
and resource limits.

## Completed Attack Order

### Stage 1: Immediate Playability - Complete

1. Bounded single-page layout.
2. Adjustment UI state.
3. Pending supply-center control marker.

These are isolated client changes with immediate playtest value.

### Stage 2: Explain the Game - Complete In Memory

1. Define the public phase-report schema.
2. Retain immutable phase reports and snapshots in memory.
3. Add the turn-history and report UI.

This creates the data contract needed by every replay feature.

### Stage 3: Diplomatic Observability - Backend Complete

1. Add server-owned conversation presence and locking.
2. Add privacy-aware presence UI.
3. Expand model-run artifacts into the structured decision journal.

Presence authorization is covered. Journal exposure remains intentionally
deferred pending observer/research authorization.

### Stage 4: Replay - Initial Version Complete

1. Build deterministic replay sequencing.
2. Add board animations and playback controls.
3. Add reduced-motion and skip behavior.

### Stage 5: Export and Research - JSON Complete, Infrastructure-Gated

1. Export public JSON archives.
2. Build standalone HTML replay.
3. Add browser WebM capture.
4. Add server-side MP4 only if operationally justified.
5. Add optional post-game private press and LLM-journal research exports.

## Next Infrastructure Sequence

1. Add a durable room, player-session, message, phase-report, and run-artifact
   store with schema migrations.
2. Introduce observer/research authorization separately from host and player
   roles.
3. Add a background runner for bounded all-LLM games with pause, resume, spend
   limits, failure recovery, and checkpointing.
4. Version the public archive schema and build a standalone replay reader.
5. Evaluate browser WebM first; add server-side MP4 only if deployment resource
   limits make it operationally acceptable.

## Independent Issue List

Suggested issue names:

- `[done] UI-01 Viewport-bound application layout`
- `[done] UI-02 Adjustment remaining-count behavior`
- `[done] MAP-01 Pending Fall control markers`
- `[done] PRESS-01 Conversation presence schema`
- `[done] PRESS-02 Privacy-aware conversation availability UI`
- `[backend] LLM-01 Structured model-run decision journal`
- `[done] HISTORY-01 Public phase-report schema`
- `[done] HISTORY-02 In-memory phase timeline`
- `[done] HISTORY-03 Turn report panel`
- `[done] REPLAY-01 Deterministic replay sequencer`
- `[initial] REPLAY-02 Board adjudication animations`
- `[done] EXPORT-01 Public JSON game archive`
- `[blocked: persistence] DATA-01 Durable game/event storage`
- `[blocked: authorization] LLM-02 Observer journal UI and export`
- `[blocked: archive versioning] EXPORT-02 Standalone HTML replay`
- `[blocked: media stack] EXPORT-03 WebM capture`
- `[blocked: deployment] EXPORT-04 Headless MP4 renderer`
