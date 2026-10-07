# AI Move Suggestion Plan

> **Historical.** Written before the scenario flow existed; kept for context. It does not describe current behaviour and its setup steps should not be followed. See [README.md](README.md) for current documentation.

## Goal

Introduce an optional tactical suggestion layer so LLMs do less raw move
formatting and can choose among plausible orders with private diplomacy as an
influence.

## Current Baseline

- Godip adjudicates submitted movement orders.
- The Go adapter exposes authoritative legal-order generation.
- Client and server have generated adjacency data for armies and fleets.
- The LLM prompt includes a versioned canonical board context and stable legal
  order IDs.

## Implementation Plan

- Produce ranked candidate order-ID sets from the Godip legal-order catalog.
- Cover all-hold, adjacent moves, support holds, support moves, and available
  convoy combinations without maintaining a second legality implementation.
- Feed ranked candidates into the LLM prompt with stable candidate IDs.
- Let the LLM select a candidate ID or exactly one legal order ID per unit.
- Keep Godip authoritative for both option generation and adjudication.

## Running Log

- 2026-06-25: Initial plan created. First implementation cut will keep the
  advisor deterministic and server-local, with no external research model
  dependency.
- 2026-06-25: Implemented a deterministic server-side tactical advisor that
  emits ranked full-order candidates for holds, adjacent moves, simple supports,
  and own-fleet convoy opportunities. Order prompts now include candidate IDs,
  and structured order output can select a candidate ID or submit explicit
  actions.
- 2026-06-26: Replaced advisor-created orders with Godip-issued legal order IDs.
  Suggestions and free selections now expand through the same catalog used by
  automated-order validation.
