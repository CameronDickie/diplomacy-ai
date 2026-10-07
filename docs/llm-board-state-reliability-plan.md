# LLM Board-State Reliability Plan

> **Historical.** Written before the scenario flow existed; kept for context. It does not describe current behaviour and its setup steps should not be followed. See [README.md](README.md) for current documentation.

## Goal

Prevent automated powers from inventing board ownership, adjacency, or legal
orders. Model quality and cost experiments should measure strategic judgment,
not whether a model can recall the standard Diplomacy map.

## Implementation

- Build a versioned prompt context from generated canonical territory data.
- Represent supply-center ownership, original home power, current occupation,
  and pending Fall capture as separate fields.
- Ask Godip for every legal movement order available to the acting power.
- Convert legal orders to stable IDs and require the model to select exactly one
  supplied ID per active unit, or one supplied full-order suggestion.
- Generate tactical suggestions only from Godip-issued legal IDs.
- Cache legal-order catalogs per power and orders phase.
- Skip the paid order request and fall back to holds if legal-order generation
  fails.

## Running Log

- 2026-06-26: Confirmed the previous prompt only supplied direct movement
  options for the acting power. Other topology was left to model memory.
- 2026-06-26: Added the `LEGAL_ORDERS` engine operation, deterministic legal
  order IDs, versioned full-map context, ownership/occupation separation, and
  legal-ID structured output.
- 2026-06-26: Refactored tactical suggestions and automated-order validation to
  use the same Godip catalog. Added offline regressions for Adriatic/Greece,
  support moves, convoys, friendly occupied destinations, split coasts, build
  sites, stable IDs, and complete per-unit selection.

## Follow-Up

- Expose the legal-order catalog to the visual order UI.
- Add agreement-to-order consistency evaluation.
- Benchmark approved paid models only after these deterministic fixtures are
  stable.
