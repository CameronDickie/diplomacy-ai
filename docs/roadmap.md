# MVP Roadmap

Detailed playtest-derived feature workstreams and acceptance criteria are kept
in [playtest-feature-notebook.md](./playtest-feature-notebook.md).
The next post-Discord playtest iteration is specified in
[next-playtest-workstreams.md](./next-playtest-workstreams.md).
The second longer-playtest iteration is tracked in
[playtest-iter2-feature-notebook.md](./playtest-iter2-feature-notebook.md) and
[playtest-iter2-work-queue.md](./playtest-iter2-work-queue.md).

## 1. Complete Rules Workflow

- Route retreats and adjustments through Godip.
- Generate complete legal-order options from the engine so the client does not
  infer support and convoy menus.
- Expand fixtures for support cutting, convoy disruption, Fall ownership,
  retreats, and adjustments.

## 2. Durable Private Games

- Store games, players, token hashes, orders, messages, and phase history in
  SQLite.
- Restore active rooms after restart.
- Add host-configured phase deadlines and missing-order defaults.
- Add named games and a host transfer/recovery mechanism.

## 3. Lobby Power Selection

- Let human players request an available power or choose random assignment.
- Reject stale power selections without assigning a different country silently.
- Let hosts configure provider, model, and persona independently for each LLM
  seat.

## 4. Usable Board

- Add pointer-centered wheel zoom while retaining button controls.
- Add touch pinch zoom after the mobile board interaction is stabilized.
- Draw pending and resolved order arrows in the SVG `orders` layer.
- Add click workflows for support and convoy orders.
- Improve mobile layout and accessibility.
- [x] Lock Fall supply ownership timing with regression tests.
- [x] Add controlled supply-center fills and striped potential-capture styling.
- Add explicit last-occupier/non-supply control state if that becomes a
  desired board concept.

## 5. Negotiation

- Private power-to-power channels, phase timestamps, and reconnect history are
  implemented in memory.
- Add optional global press channels.
- Lock messages and orders at phase deadlines.
- Store a replayable event log separate from transient Socket.IO events.
- Replace room-wide conversation serialization with per-power locking so
  disjoint live conversations can run concurrently.
- [x] Schedule configured autonomous LLM conversations concurrently when their
  power sets do not overlap.
- Add accepted/declined/queued live conversation requests while keeping
  ordinary private messages asynchronous.
- [x] Scope typing indicators to the viewer's active diplomatic reply rather
  than unrelated LLM work.

## 5A. Game Sidebar

- [x] Consolidate Powers, Orders, and Discord into one tabbed sidebar.
- [x] Replace separate player and supply sections with expandable power rows.
- Drive submitted, requested, queued, active, disconnected, and model-decision
  indicators from server-owned activity state.
- [x] Collapse browser chat by default with a global unread count.
- Add per-power unread counts and persisted chat open/collapsed preference.

## 6. LLM Powers

- Route every automated order, retreat, build, and diplomatic reply through the
  `PowerController` interface; retain the deterministic stub controller for
  development and provider failure fallback.
- [x] Provide each controller with a versioned canonical board snapshot that
  separates ownership, occupation, topology, and adjustment eligibility.
- [x] Generate movement options through Godip and require stable legal-order
  IDs instead of free-form model-authored orders.
- Require schema-constrained retreat, build, and diplomatic decisions and keep
  their validation server-authoritative.
- Schedule bounded LLM planning when an orders phase begins, while keeping final
  LLM decisions after all active human powers submit so the latest negotiations
  are considered.
- A host-configured number of rotating LLM initiators use cheaper role-specific
  planner models to select a relevant human or LLM recipient and open a
  conversation.
- Let each structured opening and reply state whether another answer is
  required. Warn the models at a configured message count and enforce a
  server-side hard cap regardless of model output.
- Retry invalid structured output once with validation feedback, then fall back
  to holds, disbands, or waived builds so provider failure cannot stall a game.
- Serialize message handling per LLM power and update its shared memory after
  every inbound and outbound message.
- Add provider adapters incrementally. Keep model identifiers configurable per
  seat but resolved through server-owned model roles, allowlists, and budgets so
  quality and cost tiers can be changed without orchestration changes.
- Record private model artifacts including prompt version, model role,
  structured response, validation failures, retry count, fallback reason,
  latency, token usage, and estimated cost.
- Add evaluation fixtures for action legality, agreement recall, cross-channel
  consistency, fallback rate, latency, and cost.
- Add a durable all-LLM simulation runner with pause/resume, per-game token and
  dollar budgets, maximum year/turn limits, checkpoints, provider backoff,
  observability, and explicit termination reasons.

## 7. Voice and Discord

- [x] Add optional single-guild coordinator and seven power bot identities.
- [x] Route Discord DMs through canonical diplomacy history and LLM memory.
- [x] Add short-lived browser-to-Discord account linking.
- [x] Add feature-flagged explicit-turn Discord voice with OpenAI Realtime,
  transcript retention, raw-audio deletion, interruption, and hard limits.
- [ ] Validate Discord audio receive and DAVE behavior in the target local
  guild before enabling voice by default.
- [ ] Persist guild mappings, player links, transcripts, and recoverable voice
  cleanup state before remote deployment.
- [ ] Define moderation and disclosure policy before opening the service beyond
  trusted friends.

## Deployment Gate

Before hosting beyond a trusted LAN: persistence, TLS, origin restrictions,
rate limits, payload limits, secrets management, backups, and dependency audit
must all be in place.
