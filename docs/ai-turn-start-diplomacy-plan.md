# AI Turn-Start Diplomacy Plan

> **Historical.** Written before the scenario flow existed; kept for context. It does not describe current behaviour and its setup steps should not be followed. See [README.md](README.md) for current documentation.

## Goal

Let LLM powers initiate diplomacy near the beginning of an orders phase so
human players are prompted to engage before submitting orders.

## Current Baseline

- Autonomous LLM-to-LLM diplomacy currently starts only after all active humans
  submit orders.
- Incoming human messages to LLM powers already trigger bounded replies.
- Conversation locking and presence are server-owned.
- LLM memory is private and power-scoped.

## Implementation Plan

- Schedule a bounded turn-start planning pass when an orders phase begins.
- Reuse existing conversation locks and message caps.
- Allow turn-start initiatives to target human or LLM powers.
- Deliver LLM-to-human openings as normal private automated messages and track
  an outreach request for the phase.
- Mark requests `REPLIED` when the human responds, `IGNORED` when they submit
  orders without responding, and `EXPIRED` if the phase ends first.
- Feed ignored outreach into private LLM context so future diplomacy and order
  selection can become less trusting or more aggressive.

## Running Log

- 2026-06-25: Initial plan created. First implementation cut will make
  turn-start planning non-blocking for human order entry, but final LLM orders
  will wait for the pass to finish before generation.
- 2026-06-25: Implemented non-blocking orders-phase planning. LLMs may target
  humans or LLMs at phase start; LLM-to-human openings are normal private
  automated messages. Outreach request records remain server-private to avoid
  leaking pairings through public game state. Ignored/replied/expired outcomes
  are folded into the relevant LLM private prompt context.
