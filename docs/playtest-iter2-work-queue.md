# Playtest Iteration 2 Work Queue

This queue turns [playtest-iter2-feature-notebook.md](./playtest-iter2-feature-notebook.md)
into implementation-sized workstreams. The order is intentional: protect
multiplayer correctness first, then remove high-friction order-entry bugs, then
polish conversation and map presentation.

## Queue Policy

- Treat each queued item as independently shippable.
- Prefer server-owned state over client inference when privacy, authorization,
  or phase progression is involved.
- Keep LLM diagnostics structured. Do not store or display hidden
  chain-of-thought.
- Friend-test blockers are marked **Gate**. Nice-to-have polish is marked
  **Polish**.

## Phase 0: Friend-Test Gate

### I2-00: Multiplayer Pre-Flight Review

**Type:** Gate  
**Status:** Automated authorization pass started; manual smoke test pending.  
**Depends on:** none  
**Primary risk:** hidden authorization or reconnect bugs with multiple humans

Audit and test multi-human behavior before inviting friends.

Tasks:

- [x] Add or update tests for seat ownership, session-token scoping, and
  unauthorized order/retreat/build/Discord/voice actions.
- [x] Confirm host-only diagnostics and event log visibility are enforced by server
  authorization, not just hidden by the client.
- [ ] Smoke test two browser clients plus one Discord-linked user through join,
  order submission, adjudication, retreat/build if reachable, reconnect, and
  chat.
- [ ] Confirm private messages, model memory, voice transcripts, and exact
  conversation pairings stay scoped to authorized viewers.

Done when:

- Automated authorization tests pass.
- Manual two-human smoke test has no seat leakage, stale session takeover, or
  cross-power action bug.

## Phase 1: Human Order Safety

### I2-01: Disable Human Submit for Incomplete Orders

**Type:** Gate  
**Status:** Implemented; needs browser smoke.  
**Depends on:** I2-00 only for final friend-test signoff  
**Primary risk:** human player believes an order was submitted when it was not

Prevent humans from submitting movement orders while required units are missing
valid queued orders. LLMs may continue to default missing orders to hold.

Tasks:

- [x] Compute missing required human orders in the client from current phase/unit
  state and queued draft orders.
- [x] Disable submit while missing orders exist.
- [x] Show a concise list of unordered units and the reason submit is disabled.
- [x] Preserve edit behavior: removing or editing a queued order returns that unit
  to the missing/active state.

Done when:

- A human cannot submit movement orders with unassigned units.
- The disabled submit state tells the player exactly what remains.

### I2-02: Pending Order Unit Styling

**Type:** Gate  
**Status:** Implemented; needs browser smoke.  
**Depends on:** I2-01  
**Primary risk:** players lose track of which units already have draft orders

Visually distinguish units with queued orders.

Tasks:

- [x] Grey/desaturate or add a pending-order ring to units with queued orders.
- [x] Keep ordered units clickable for review/edit.
- [x] Use a distinct hover/selected style so pending and selected do not conflict.

Done when:

- Ordered, unordered, selected, and disabled units are visually distinct.

### I2-03: Support Candidate Filtering

**Type:** Gate  
**Status:** Implemented with client-side adjacency filtering; engine-backed legal menus remain future work.  
**Depends on:** I2-01  
**Primary risk:** support UI teaches bad legal intuition by showing every unit

Filter support order menus to relevant units and targets.

Tasks:

- [x] For support-hold, show units adjacent to the supporter where support could
  plausibly apply.
- [x] For support-move, show source/target pairs where the supporter is adjacent to
  the target province.
- [x] Keep server validation authoritative.
- [ ] Add tests or fixtures for common army/fleet support adjacency cases.

Done when:

- Support menus are materially shorter and match board geometry.

### I2-04: Retreat and Build Submit Safety

**Type:** Gate  
**Status:** Implemented; needs browser smoke.  
**Depends on:** I2-00  
**Primary risk:** accidental disband or confusing duplicate adjustment submit

Improve retreat/build interaction safety.

Tasks:

- [x] Default retreat selection to a legal retreat destination when one exists,
  not disband.
- [x] Disable build/disband submit while a submission is in flight.
- [x] Show a submitted/final state until phase changes.
- [x] Confirm duplicate build attempts are rejected server side and not retried by
  the client.

Done when:

- The first retreat action is not accidental disband.
- Double-clicking adjustment submit cannot create duplicate client behavior.

## Phase 2: State Legibility

### I2-05: Unified Power Activity Styling

**Type:** Gate  
**Status:** Partially implemented for visible voice/submitted states; richer server activity snapshot remains pending.  
**Depends on:** I2-00  
**Primary risk:** players cannot tell who is available, listening, submitted,
  or busy

Add clear power-row activity styling.

Tasks:

- [x] Strong glow for active voice conversations visible to the viewer.
- [x] Dim glow/ring for voice sessions that exist but are not listening.
- [x] Desaturate or darken power boxes after order submission or completed LLM
  decision.
- [x] Avoid leaking exact private pairings to uninvolved players.

Done when:

- Voice, text conversation, submitted, queued, and deciding states can be read
  from the power dashboard without opening chat.

### I2-06: Conversation Grouping and Privacy Review

**Type:** Polish  
**Status:** Deferred; requires richer viewer-filtered activity snapshots.  
**Depends on:** I2-05  
**Primary risk:** grouping UI leaks private diplomacy

Experiment with a shared visual group for powers currently conversing.

Tasks:

- [ ] Show exact grouped powers only to participants or when public-pairing mode is
  enabled.
- [ ] Show generic busy state to uninvolved players.
- [ ] Reuse server conversation presence instead of client timers.

Done when:

- Participants get useful context without giving uninvolved players extra
  intelligence.

### I2-07: Host/Event Log Visibility Pass

**Type:** Gate  
**Status:** Partially implemented; final policy decision pending.  
**Depends on:** I2-00  
**Primary risk:** host-player sees privileged diagnostics

Confirm all debug/event log content has the correct audience.

Tasks:

- [x] Audit event payloads used by the UI.
- [x] Hide or filter host-only diagnostics from non-host players.
- [ ] Decide whether a host who is also playing should see operational diagnostics
  during the game or only after game end.

Done when:

- Player-visible logs contain no private pairings, hidden model artifacts, or
  opponent-only state.

## Phase 3: Map and List Polish

### I2-08: Supply Depot Deduplication

**Type:** Gate  
**Status:** Implemented by hiding anchor-only depot paths while keeping the foreground symbols.  
**Depends on:** none  
**Primary risk:** duplicate depot markers make the board look broken

Remove the extra shifted supply depot markers.

Tasks:

- [x] Audit map layers for supply-center symbols versus unit anchor markers.
- [x] Render exactly one visible supply-center symbol per center.
- [x] Keep unit placement and click targets unchanged.

Done when:

- Every supply center has one depot marker and stationed units still align.

### I2-09: Zoom Limit Increase

**Type:** Polish  
**Status:** Implemented; max zoom increased to 350%.  
**Depends on:** I2-08 preferred  
**Primary risk:** small-screen players cannot inspect dense regions

Allow zoom beyond 100%.

Tasks:

- [x] Increase max zoom while preserving wheel zoom, buttons, and pan bounds.
- [ ] Confirm order arrows and hit targets stay aligned at high zoom.
- [ ] Keep mobile controls usable.

Done when:

- Players can zoom past 100% without arrows, labels, or click targets drifting.

### I2-10: Sorted Orders and Chats

**Type:** Polish  
**Status:** Implemented for public order reports and conversation list ordering.  
**Depends on:** none  
**Primary risk:** later-game information becomes hard to scan

Sort high-volume lists by player relevance.

Tasks:

- [x] Sort public order summaries by country, then unit/province.
- [x] Add country color accents to order rows.
- [x] Sort conversations by most recent message while preserving unread state.

Done when:

- Orders are scannable by country and recent chats naturally rise to the top.

## Phase 4: LLM Reliability and Context

### I2-11: LLM Validation Telemetry

**Type:** Gate  
**Status:** Partially implemented in backend run artifacts; host-facing summaries and counters remain.  
**Depends on:** none  
**Primary risk:** repeated structured-output failures are hard to diagnose

Expose structured diagnostics for order/build/reply validation failures.

Tasks:

- [x] Record validation reason, retry count, fallback reason, final accepted
  action, provider/model, latency, and phase.
- [ ] Show concise host/debug summaries without chain-of-thought.
- [ ] Add aggregate fallback-rate counters for a game.

Done when:

- A failed LLM order/build attempt can be diagnosed from structured telemetry
  rather than server stdout alone.

### I2-12: Turn-Start LLM Planning Spike

**Type:** Polish  
**Status:** Initial implementation completed; live playtest tuning remains.  
**Depends on:** I2-11 and current conversation locks  
**Primary risk:** changing lifecycle timing can destabilize phase progression

Prototype turn-start LLM planning without moving final order generation.

Tasks:

- [x] Add a short planning pass at the beginning of eligible phases.
- [x] Store desired conversation targets and whether a reply is needed.
- [x] Queue requests through the existing conversation scheduler.
- [x] Keep final LLM order decisions at resolution time.

Done when:

- LLMs can initiate relevant diplomacy before humans submit, without blocking
  normal human order entry.

### I2-13: Relationship Summary Context

**Type:** Polish  
**Status:** Deferred; useful but not required for first deployment.  
**Depends on:** public phase history and message history  
**Primary risk:** useful context accidentally leaks private messages

Generate concise pairwise relationship summaries.

Tasks:

- [ ] Derive recent conflicts, bounces, dislodgements, supports, and supply-center
  captures from public phase history.
- [ ] Reference private message IDs only for authorized viewers and LLM prompt
  context.
- [ ] Add a small “history with this power” panel in chat or expanded power rows.

Done when:

- Humans and LLMs get useful relationship context without cross-player private
  content leakage.

### I2-14: Message Snapshot References

**Type:** Polish  
**Status:** Deferred; best paired with persistence/event-store work.  
**Depends on:** public phase history; persistence can deepen this later  
**Primary risk:** duplicating full board snapshots per message bloats memory

Attach stable board-state references to messages.

Tasks:

- [ ] Store phase/year and phase-history snapshot reference on each message.
- [ ] Avoid copying the full map state into every message.
- [ ] Add replay/review affordance to jump from a message to the relevant board
  state later.

Done when:

- A message can be associated with the board state at send time.

## Phase 5: Voice Stability

### I2-15: OpenAI Voice Socket Diagnostics

**Type:** Gate if voice will be used in friend test; otherwise Polish  
**Status:** Partially implemented; live long-session validation pending.  
**Depends on:** none  
**Primary risk:** long voice sessions fail silently

Add diagnostics and recovery for OpenAI realtime socket drops.

Tasks:

- [x] Log close code, reason, session age, voice model, active power, and whether
  audio was in flight.
- [x] Surface recoverable UI errors when the OpenAI socket drops.
- [ ] Ensure Discord channel cleanup still runs in a live dropped-socket case.
- [ ] Consider dependency pin/rollback only if diagnostics confirm a regression.

Done when:

- A dropped voice socket leaves a clear UI/error trail and does not strand the
  bot or channel.

## Recommended Execution Order

1. I2-00 Multiplayer Pre-Flight Review.
2. I2-01 Disable Human Submit for Incomplete Orders.
3. I2-02 Pending Order Unit Styling.
4. I2-03 Support Candidate Filtering.
5. I2-04 Retreat and Build Submit Safety.
6. I2-08 Supply Depot Deduplication.
7. I2-05 Unified Power Activity Styling.
8. I2-07 Host/Event Log Visibility Pass.
9. I2-11 LLM Validation Telemetry.
10. I2-15 OpenAI Voice Socket Diagnostics if voice is in the friend test.
11. I2-10 Sorted Orders and Chats.
12. I2-09 Zoom Limit Increase.
13. I2-06 Conversation Grouping and Privacy Review.
14. I2-12 Turn-Start LLM Planning Spike.
15. I2-13 Relationship Summary Context.
16. I2-14 Message Snapshot References.
