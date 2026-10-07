# Next Playtest Workstreams

> **Historical.** Written before the scenario flow existed; kept for context. It does not describe current behaviour and its setup steps should not be followed. See [README.md](README.md) for current documentation.

This plan converts the June 2026 playtest feedback into independent workstreams.
The implementation order protects rules correctness first, then establishes the
server contracts needed by the new player dashboard.

## Rules Decision: Supply-Center Ownership

Standard Diplomacy does not track the last power that visited a province.
Supply-center ownership changes only after Fall adjudication:

- A power captures a supply center when one of its units occupies that province
  at the end of a Fall movement/retreat sequence.
- Once captured, the power retains ownership after moving out in a later Spring
  or Fall.
- Ownership changes only when another power occupies the center at the end of a
  later Fall.
- Entering a center in Spring and leaving it during Fall does not capture it,
  even when nobody replaces the departing unit.

The current server preserves captured ownership correctly after units leave,
but it applies ownership immediately after Fall movement adjudication. That is
too early when the game enters a Fall retreat phase, because a legal retreat
into a supply center must be included in the end-of-turn position. The first
workstream corrects this timing and adds explicit regression coverage before
changing map presentation.

## Workstream SC-01: Supply Ownership Regression Suite

**Status:** Implemented in the current playtest pass.

Move Fall ownership finalization out of the movement-only path:

- If Fall movement produces no retreat phase, finalize ownership immediately
  before victory/build calculations.
- If Fall retreats are required, finalize ownership after all retreats and
  forced disbands resolve.
- Record ownership changes once in the public Fall result sequence; do not emit
  contradictory movement and retreat ownership snapshots.

Add deterministic tests covering:

- Capture of neutral and enemy centers after successful Fall occupation.
- Ownership retention when the capturing unit leaves in the following Spring.
- No capture when a unit enters in Spring but vacates during Fall.
- No ownership change after Spring adjudication.
- Dislodgement and failed movement at a center.
- Legal Fall retreat into an unoccupied supply center.
- Ownership-change entries in the public Fall report.

No new historical “last occupier” field should be added. Current owner and
current unit occupancy are sufficient.

## Workstream MAP-02: Ownership and Pending-Control Styling

**Status:** Partially implemented in the current playtest pass.

The board now uses stronger controlled supply-center fills and diagonal
owner/occupier stripes when current occupation differs from legal ownership.
The existing pending-control ring remains as a compact fallback cue.

Remaining work: non-supply province control still needs an explicit server
concept if we want to display “last occupied by” outside supply centers.

Render three visually distinct province states:

1. **Owned non-supply province:** a lighter power tint.
2. **Owned supply center:** a stronger power tint while preserving the existing
   supply-center symbol.
3. **Foreign or neutral supply center currently occupied:** diagonal stripes
   combining the legal owner's base color with the occupier's color.

The striped state is labeled **potential Fall capture**, not guaranteed
ownership. It appears whenever occupier and owner differ, including Spring, and
disappears when the unit leaves, is displaced, or Fall ownership resolves.

Implementation notes:

- Generate SVG patterns in a dedicated map definition layer and reference them
  by stable owner/occupier IDs.
- Keep labels, units, orders, and click targets above the fill pattern.
- Retain a compact legend and expose owner/occupier text in the SVG accessible
  label.
- Use a non-animated high-contrast fallback under reduced-motion or forced
  colors.

## Workstream PRESS-03: Concurrent Conversation Scheduler

**Status:** Partially implemented in the current playtest pass.

The room-wide diplomacy queue has been replaced with per-participant locks.
Disjoint LLM conversations can now run concurrently, and conversations sharing
one power still serialize. Autonomous LLM initiators are scheduled together
instead of one after another.

Remaining work: expose the richer viewer-filtered activity snapshot described
below, and formalize FIFO request/session records for live conversations.

Replace the room-wide single conversation with a scheduler that supports
parallel conversations when their power sets do not overlap.

Server model:

- Store active conversations in a map keyed by conversation ID.
- Acquire both participant locks atomically in canonical power order.
- A power may participate in at most one live conversation.
- Disjoint pairs, such as England-France and Austria-Turkey, may run
  concurrently.
- Conflicting requests enter a FIFO queue and begin when both powers are free.
- Voice, autonomous LLM exchanges, and accepted live text sessions use the same
  locks.
- Asynchronous text messages remain deliverable while a power is busy, but an
  LLM reply queues behind that power's lock.
- The order phase waits for all configured autonomous conversation jobs to
  finish before generating final LLM orders.

Autonomous negotiation should schedule all selected initiators together rather
than awaiting each conversation serially. The scheduler prevents overlapping
use of the same power without reducing unrelated conversations to one global
queue.

Presence changes from one `ConversationPresencePayload` to a viewer-filtered
snapshot containing:

- Active conversation IDs visible to the viewer.
- Per-power availability: `AVAILABLE`, `REQUESTED`, `QUEUED`, or `BUSY`.
- Exact participants only when the viewer participates or public pairing mode
  is enabled.
- Message count and cap only for visible conversations.

Public per-power busy indicators permit players to infer some diplomatic
activity. Keep the existing host setting to choose between generic availability
and fully public pairings.

## Workstream PRESS-04: Live Conversation Requests

**Status:** Depends on PRESS-03.

Conversation requests apply to live sessions, not ordinary asynchronous DMs or
web messages.

Request lifecycle:

- `PENDING`: recipient has not answered.
- `QUEUED`: accepted, but one participant is busy.
- `ACTIVE`: both locks acquired.
- `DECLINED`, `CANCELLED`, `EXPIRED`, or `COMPLETED`.

Behavior:

- A human requests either a live text-presence session or a voice session.
- Human recipients must accept or decline.
- An idle LLM automatically accepts.
- A busy LLM accepts into the queue and the requester sees that it is waiting.
- Requests expire after a host-configurable timeout, defaulting to two minutes.
- Either participant may cancel before activation or end an active session.
- Human-to-human voice creates a temporary private Discord channel without
  OpenAI audio.
- Human-to-LLM voice continues through the existing OpenAI Realtime bridge.
- Linked human recipients receive the request in the browser and through a
  coordinator-bot DM; browser controls remain authoritative.

Add request, accept, decline, cancel, and end socket commands with server-side
player authorization. Reconnect delivers the current request/session snapshot.

## Workstream STATUS-01: Unified Power Activity Model

**Status:** Partially implemented.

The browser chat typing indicator is now scoped to the visible selected
conversation, so hidden LLM-to-LLM activity no longer looks like a reply in the
human's open chat.

The full server-derived per-power activity snapshot remains pending.

Create a server-derived per-power status instead of combining unrelated client
timers:

- Order state: `NOT_REQUIRED`, `AWAITING_ORDERS`, `SUBMITTED`, `RESOLVING`.
- Conversation state: `AVAILABLE`, `REQUEST_PENDING`, `QUEUED`, `ACTIVE`.
- Model activity: `IDLE`, `DIPLOMACY_REPLY`, `ORDER_DECISION`,
  `RETREAT_DECISION`, `BUILD_DECISION`.
- Connection state for humans and provider availability for LLMs.

The server emits viewer-filtered activity snapshots on every transition.
Private pairings and private request identities remain hidden from uninvolved
players unless public pairing mode is enabled.

The chat typing indicator is shown only when:

- The model activity is `DIPLOMACY_REPLY`.
- The run belongs to the conversation currently selected by the viewer.
- The viewer is a participant in that conversation.

Order generation or an LLM replying to another power must never display as
typing in the viewer's selected chat.

## Workstream UI-03: Tabbed Game Sidebar

**Status:** Partially implemented.

The in-game left sidebar now has Powers, Orders, and Discord tabs. Orders
currently means public turn history/replay controls; the order-entry workflow
remains in the right panel to avoid moving draft state before the activity
contract is finished.

Replace the separate supply-center list, player list, right-side order panel,
and standalone Discord card with one tabbed sidebar:

- **Powers**
- **Orders**
- **Discord**

Keep Turn History below the tabs or as a fourth tab after playtesting; do not
move it during this workstream.

The Orders tab reuses the existing order component and pending-order state. The
map expands into the space currently occupied by the right order column.
Switching tabs must not clear selected units, drafts, pending orders, Discord
codes, or voice state.

Responsive behavior:

- Desktop uses a fixed sidebar plus map.
- Mobile presents the tabs above their scrollable panel.
- Tab selection is retained locally across rerenders but resets sensibly when
  leaving a game.

## Workstream UI-04: Expandable Power Dashboard

**Status:** Partially implemented.

Power rows are expandable and show supply-center count, unit count, player or
controller identity, owned supply-center names, submitted/pending state, and
visible conversation activity. Request/queued states remain pending on
PRESS-04.

Each power row contains:

- Power color/status orb.
- Country and player/controller name.
- Owned supply-center count and unit count.
- Concise current activity label.
- Expand/collapse control.

Expanded content contains:

- Named owned supply centers.
- Current units.
- Submitted/awaiting order state.
- Human connection or LLM provider/model.
- Conversation availability and the request-conversation action.

Status orb behavior:

- Normal solid orb: available and awaiting action.
- Darkened/desaturated orb: orders submitted.
- Rotating ring: active conversation.
- Pulsing outer ring: incoming conversation request.
- Dashed rotating ring: accepted but queued.
- Error outline: disconnected human or unavailable configured provider.

Animations must honor `prefers-reduced-motion`, replacing spinner and pulse
with static ring styles.

## Workstream UI-05: Collapsible Chat Dock

**Status:** Partially implemented.

Browser chat now starts collapsed with a global unread count and can be
reopened from a slim dock rail.

Remaining work: local-storage preference, per-power unread counts, and keeping
voice/session controls available from the Powers tab.

- Keep browser chat as a synchronized fallback and transcript viewer.
- Start collapsed by default for new browsers.
- Persist the user's open/collapsed preference in local storage.
- Show unread counts by power while collapsed.
- Opening chat clears unread state only for the selected conversation.
- Preserve the selected recipient and scroll position when minimizing.
- Keep voice/session controls accessible from the Powers tab so collapsing chat
  does not prevent live-conversation management.

The event log remains independently collapsible.

## Recommended Delivery Order

1. `SC-01` Supply ownership regression suite.
2. `PRESS-03` Concurrent per-power scheduler and presence schema.
3. `PRESS-04` Conversation request lifecycle.
4. `STATUS-01` Viewer-filtered power activity snapshots and typing fix.
5. `UI-03` Tabbed sidebar and order-panel relocation.
6. `UI-04` Expandable power dashboard.
7. `MAP-02` Province shading and pending-capture stripes.
8. `UI-05` Chat collapsed by default with unread handling.

MAP-02 may be developed in parallel with PRESS-03 through STATUS-01 after
SC-01 passes. UI-03 and UI-04 should share one integration branch because both
reshape the sidebar, but remain separately reviewable commits.

## Acceptance Test Matrix

- Captured centers remain owned after the occupying unit leaves in Spring.
- Spring-only occupation never changes ownership.
- Disjoint LLM pairs converse concurrently; overlapping pairs never do.
- A queued conversation starts after both powers become available.
- Human requests require acceptance; idle LLM requests auto-accept.
- Order generation never renders as chat typing.
- An LLM replying to Russia does not render as typing in Italy's chat.
- Power rows accurately show submitted, requested, queued, active, and
  disconnected states without exposing unauthorized pairings.
- Sidebar tab changes preserve order drafts and active voice sessions.
- Chat is collapsed initially, retains preference, and reports unread messages.
- Province fills distinguish owned supply, owned non-supply, and potential Fall
  capture in normal, reduced-motion, and high-contrast modes.
