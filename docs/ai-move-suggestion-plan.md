# AI Move Suggestion Plan

## Goal

Introduce an optional tactical suggestion layer so LLMs do less raw move
formatting and can choose among plausible orders with private diplomacy as an
influence.

## Current Baseline

- Godip adjudicates submitted movement orders.
- The Go adapter does not yet expose legal-order generation.
- Client and server have generated adjacency data for armies and fleets.
- The LLM prompt includes current units, state, messages, memory, and movement
  options.

## Implementation Plan

- Add a deterministic tactical advisor interface that produces ranked candidate
  order sets.
- Start with internal heuristics: all-hold, adjacent supply-center moves,
  simple supports, and available convoy-style army moves when own fleets can
  bridge the route.
- Feed ranked candidates into the LLM prompt with stable candidate IDs.
- Let the LLM select a candidate ID or provide explicit orders; server
  validation remains authoritative either way.
- Track a later rules-engine milestone for authoritative legal-order
  generation from Godip.

## Running Log

- 2026-06-25: Initial plan created. First implementation cut will keep the
  advisor deterministic and server-local, with no external research model
  dependency.
- 2026-06-25: Implemented a deterministic server-side tactical advisor that
  emits ranked full-order candidates for holds, adjacent moves, simple supports,
  and own-fleet convoy opportunities. Order prompts now include candidate IDs,
  and structured order output can select a candidate ID or submit explicit
  actions.
