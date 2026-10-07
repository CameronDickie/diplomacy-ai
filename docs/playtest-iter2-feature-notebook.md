# Playtest Iteration 2 Feature Notebook

> **Historical.** Written before the scenario flow existed; kept for context. It does not describe current behaviour and its setup steps should not be followed. See [README.md](README.md) for current documentation.

This notebook captures the longer solo playtest that mixed Discord voice,
browser text diplomacy, LLM orders, and later-game build/retreat phases. The
goal is to identify the last practical UX and reliability work before inviting
friends into a longer multiplayer test.

## Guiding Priorities

- Make player state legible at a glance: who is talking, who is listening, who
  has submitted, and who is still deciding.
- Prevent humans from accidentally submitting incomplete or misleading orders.
- Improve order construction enough that newer players can understand support,
  retreats, builds, and pending orders without knowing every Diplomacy edge
  case.
- Keep private diplomatic activity private while still showing availability and
  busy states.
- Add diagnostics for LLM format failures without exposing hidden reasoning.

## Release Gate: Multiplayer Pre-Flight Review

Before the friends test, run a focused review of multi-human game logic.

Checklist:

- Two or more humans can join, reconnect, and retain their own seats without
  leaking another player's session token or orders.
- A human cannot submit orders, retreats, builds, Discord actions, or voice
  controls for another power.
- Human order submission waits correctly for other humans and LLMs, with clear
  UI feedback for each pending category.
- Late joins are rejected after game start, and random power assignment cannot
  collide under simultaneous joins.
- Public phase history is identical for all players, while private chat,
  Discord messages, model memory, and voice transcripts stay scoped correctly.
- Conversation presence does not reveal exact private pairings to uninvolved
  players unless an explicit public-pairing setting is enabled.
- A browser refresh during order drafting, pending submission, LLM negotiation,
  retreat, build, or voice state does not corrupt the room.
- Host-only controls and host-only event log visibility are enforced server
  side, not only hidden in the client.

Acceptance criteria:

- Add or update automated tests for the highest-risk authorization paths.
- Manually smoke test at least two browsers plus one Discord-linked user before
  inviting the group.

## Workstream A: Power Activity and Voice Presence

### Observations

- A power needs a clear visual glow while it is actively in a voice
  conversation.
- The glow should dim when the voice session exists but is not currently
  listening.
- A power box should desaturate or darken once that power has submitted or is
  done making a decision.
- It may be useful to visually group two powers inside a shared glow while they
  are conversing.

### Proposed Feature

Extend the power dashboard with a unified activity presentation:

- Active voice conversation: strong glow around the participant powers.
- Voice ready but not listening: dim glow or subdued ring.
- Submitted or completed decision: desaturated/darkened power box.
- Active two-party conversation: shared grouping treatment when both powers
  are visible to the viewer.

Privacy rule:

- Participants can see the exact other participant.
- Uninvolved players see only that a visible power is busy, unless public
  pairing mode is enabled.

Acceptance criteria:

- Voice, text, autonomous LLM negotiation, and order decision states do not
  conflict visually.
- The same state is readable without color alone.
- No private pairing is leaked to uninvolved players by the grouping UI.

## Workstream B: Turn-Start LLM Planning and Conversation Requests

### Observations

- LLM “thinking” currently tends to happen at turn end, after humans submit.
- It may be better for LLMs to evaluate their diplomatic priorities at the
  start of the turn, then queue requests to contact relevant players.
- This would make LLMs less reactive and reduce the feeling that humans are
  exclusively pacing all diplomacy.

### Proposed Feature

Move part of LLM planning to turn start:

- At the beginning of each diplomacy/order phase, each LLM performs a short
  planning pass.
- The planning pass identifies desired conversations and whether a response is
  required.
- The server schedules requests through the conversation lock/queue system.
- Final order generation still happens near resolution, using all completed
  negotiations and the latest board state.

Acceptance criteria:

- LLMs can initiate conversations before human order submission.
- Disjoint conversations can run concurrently.
- A busy power queues additional requests rather than receiving overlapping
  live conversations.
- Humans receive a clear request/accept flow for live conversations.

## Workstream C: Relationship and Interaction History

### Observations

- Conversations would benefit from a concise history of prior interactions:
  bounces, territory captures, supports, betrayals, and repeated conflicts.
- This context should help both human players and LLMs understand why a message
  matters.
- The same data could support replay and post-game review.

### Proposed Feature

Create a derived relationship summary between each pair of powers:

- Recent direct conflicts, bounces, dislodgements, and contested centers.
- Recent supports, successful cooperation, and non-aggression patterns.
- Supply centers taken from or by the other power.
- Last few private/public interaction references without exposing private
  message bodies to unauthorized viewers.

Acceptance criteria:

- Human UI shows a concise “history with this power” panel inside chat or the
  power expansion.
- LLM prompt context receives the same structured summary.
- Private message content is not leaked through relationship summaries.

## Workstream D: Safer Human Order Entry

### Observations

- Users should not be able to submit with pending or incomplete human orders.
- AI can still default incomplete orders to hold, but humans need stronger
  guardrails.
- Units with assigned orders should be greyed out or have a distinct pending
  order color.
- Support order menus currently show too many units; they should filter to
  units relevant to the second-order adjacency relationship.
- After selecting move, a map-click tool or clearer map selection mode may make
  the intended click target more obvious.

### Proposed Feature

Tighten order drafting and submission:

- Disable human submit until every required unit has a valid queued order.
- Show an explicit list of unordered units.
- Grey/desaturate units already assigned an order, while keeping them clickable
  for edit/review.
- Filter support candidates to legal or plausibly legal adjacent support
  targets instead of showing the full unit list.
- Add a clearer “select target on map” state after choosing move/support.

Acceptance criteria:

- Human users cannot submit incomplete movement orders by accident.
- The UI explains why submit is disabled.
- Editing a queued order restores the unit to the active draft state.
- Support lists are materially shorter and correspond to legal board geometry.

## Workstream E: Retreat and Build UX

### Observations

- The default retreat option should not be disband.
- Build submission can be attempted repeatedly while waiting; the engine appears
  to reject illegal duplicate builds, but the UI should avoid the confusing
  path.
- Builds and orders often require retry from LLMs because structured output
  fails validation.

### Proposed Feature

Improve adjustment and retreat safety:

- Default retreat selection to the first legal retreat location when one exists,
  not disband.
- Disable repeated submit while an adjustment submission is in flight.
- Make successful adjustment submission visibly final until the phase changes.
- Add structured validation telemetry for LLM build/order failures:
  validation reason, retry count, fallback used, and final accepted order.

Acceptance criteria:

- A human cannot accidentally disband because the first option was selected by
  default.
- Double-clicking submit does not create duplicate client actions or confusing
  retry feedback.
- LLM validation failures are visible in host/debug tooling without exposing
  hidden reasoning.

## Workstream F: Order, Chat, and History Lists

### Observations

- Order lists should be sorted by country and color coded.
- Chats should likely sort by most recent activity.
- It would be useful to store the map state with each user message, especially
  for replay or review.

### Proposed Feature

Improve list organization and historical anchors:

- Sort public order summaries by country, then unit/province.
- Use country color accents in order rows.
- Sort conversations by most recent message, with pinned/active conversation
  handling if needed.
- Store a stable phase/snapshot reference on each message. Full board snapshots
  should live in the phase history/event store rather than duplicating the
  entire map with every message.

Acceptance criteria:

- Orders are scannable by power.
- Recent chats rise to the top without losing unread indicators.
- A replay/review mode can jump from a message to the board state that existed
  when it was sent.

## Workstream G: Map Rendering Polish

### Observations

- Supply depots appear to be drawn twice in many provinces, slightly shifted.
  The thinner duplicate seems to be where the unit anchors when stationed
  there, but it is visually confusing.
- Users should probably be able to zoom beyond 100%.

### Proposed Feature

Clean up board symbols and zoom:

- Render only the primary supply-center marker.
- Keep unit anchor positions separate from supply-center presentation.
- Audit SVG layers so center markers, unit anchors, labels, order arrows, and
  province click targets have distinct responsibilities.
- Increase maximum zoom above 100%, with sensible limits for desktop and mobile.

Acceptance criteria:

- Each supply center has exactly one visible depot marker.
- Unit placement remains stable after removing duplicate markers.
- Zoom greater than 100% works with existing pan, scroll-wheel, and button
  controls.

## Workstream H: OpenAI Voice Stability

### Observations

- After upgrading to `8.21.0`, long OpenAI voice sessions may occasionally drop
  their socket.
- The issue is not yet proven, but it was first observed after that upgrade.

### Proposed Feature

Add voice-session stability diagnostics and recovery:

- Log OpenAI realtime close codes, reasons, session age, active voice model,
  and whether audio was in flight.
- Surface a concise recoverable error in the UI when the voice socket drops.
- Allow reconnecting the same voice session when Discord is still active.
- Consider pinning or rolling back the dependency if diagnostics confirm a
  regression.

Acceptance criteria:

- A dropped OpenAI voice socket does not leave the Discord bot stuck in an
  unusable state.
- Logs contain enough detail to distinguish OpenAI close, Discord receive
  failure, user silence, and server-side timeout.

## Workstream I: Full UI Communication Review

### Observations

- The UI mostly works, but a full pass is needed to confirm the wording,
  grouping, disabled states, and event messages communicate the actual game
  state.

### Proposed Review

Audit all major player-facing surfaces:

- Lobby and game setup.
- Power dashboard.
- Order entry, retreats, builds, and submit states.
- Chat and conversation request states.
- Discord link and voice controls.
- Event log and host-only diagnostics.
- Public turn history and replay.
- Map legend, hover labels, selected unit state, and order arrows.

Acceptance criteria:

- Every disabled button explains what must happen next.
- Host-only debug information is hidden from non-host players.
- Public information, private information, and debug information are visually
  distinct.
- New players can understand what action is expected without reading server
  logs or knowing implementation details.

