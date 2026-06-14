# MVP Roadmap

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

## 3. Usable Board

- Add wheel/pinch zoom and drag-to-pan.
- Draw pending and resolved order arrows in the SVG `orders` layer.
- Add click workflows for support and convoy orders.
- Improve mobile layout and accessibility.

## 4. Negotiation

- Add global and private press channels with phase timestamps.
- Lock messages and orders at phase deadlines.
- Store a replayable event log separate from transient Socket.IO events.

## 5. LLM Powers

- Put all automated seats behind a `PowerController` interface.
- Add provider adapters, structured-output schemas, budgets, retries, and
  redaction.
- Give each model a power-scoped state view and private message history.
- Record model inputs, outputs, cost, and latency for replay and evaluation.

## Deployment Gate

Before hosting beyond a trusted LAN: persistence, TLS, origin restrictions,
rate limits, payload limits, secrets management, backups, and dependency audit
must all be in place.
