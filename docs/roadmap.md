# MVP Roadmap

Detailed playtest-derived feature workstreams and acceptance criteria are kept
in [playtest-feature-notebook.md](./playtest-feature-notebook.md).

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

## 5. Negotiation

- Private power-to-power channels, phase timestamps, and reconnect history are
  implemented in memory.
- Add optional global press channels.
- Lock messages and orders at phase deadlines.
- Store a replayable event log separate from transient Socket.IO events.

## 6. LLM Powers

- Route every automated order, retreat, build, and diplomatic reply through the
  `PowerController` interface; retain the deterministic stub controller for
  development and provider failure fallback.
- Provide each controller with a power-scoped prompt snapshot containing public
  game state, legal action context, persona, private messages, strategic memory,
  and structured agreements.
- Require schema-constrained phase decisions and diplomatic replies. Validate
  ownership, completeness, action shape, and known rule constraints before
  accepting output.
- Trigger final LLM decisions only after all active human powers submit, so the
  latest negotiations are considered.
- Run a bounded autonomous negotiation round after human submission. A
  host-configured number of rotating LLM initiators use an optional cheaper
  planner model to select a relevant recipient and open a conversation.
- Let each structured opening and reply state whether another answer is
  required. Warn the models at a configured message count and enforce a
  server-side hard cap regardless of model output.
- Retry invalid structured output once with validation feedback, then fall back
  to holds, disbands, or waived builds so provider failure cannot stall a game.
- Serialize message handling per LLM power and update its shared memory after
  every inbound and outbound message.
- Add provider adapters incrementally. Keep model identifiers configurable per
  seat so quality and cost tiers can be changed without orchestration changes.
- Record private model artifacts including prompt version, structured response,
  validation failures, retry count, fallback reason, latency, and token usage.
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
