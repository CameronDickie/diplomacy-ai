# Luna decision context

`server/src/luna/` turns one frozen phase into, at most, one bounded request per
opponent power, and turns the model's answer back into an action the rules
engine then checks. It contains no transport and makes no provider call.

## What a request contains

`Context.ts` (`luna-context-v1`) writes plain text in two parts:

1. **Shared prefix**, identical for all six opponents in a phase so the provider
   can cache it: season and phase, the scenario's pinned objective, supply
   centers by power, units by power, and up to 40 lines of the previous phase's
   public results.
2. **Own section**: "You are FRANCE", the rule for how many numbers to pick, and
   that power's numbered choices grouped by unit.

It is built only from the frozen public board, the challenge definition and the
last public report. The human player's accepted orders (`PhaseJob.humanAction`)
and other opponents' saved decisions are never read, and one power never sees
another power's options. There is no rules text, map topology, chat or memory.

## Choices

`Choices.ts` numbers what a power may do; the model returns `{"choices":[…]}`.

| Phase | Listed | Must pick |
| -- | -- | -- |
| Orders | every legal order from Godip's catalog, per unit, HOLD first, then moves, supports, convoys | exactly one per active unit |
| Retreats | disband, then each legal destination (with coast) per dislodged unit | exactly one per dislodged unit |
| Builds | army and fleet (per coast) for each free owned home center | up to the allowance, one per center; empty waives |
| Disbands | each of the power's units | exactly the required number |

A power with nothing to decide — no units to order, nothing dislodged, no
adjustment, or builds owed but no free home center — gets its forced action and
**no provider call**. Out-of-range, repeated, missing or surplus numbers are
refused before the engine is consulted; the engine remains the authority on
legality.

## Bounds

A request must fit `LUNA_PRESET.maxContextBytes` (24,000) and its serialized
body must not exceed `maxInputTokens` (32,768) **in bytes**. Because a token is
never shorter than one byte, the body's byte length is a true upper bound on its
input tokens, and that bound is what `lunaReservationNanousd` prices for the
reservation. It is deliberately pessimistic.

When the full text does not fit it is reduced in a fixed order and the reduction
is reported in `LunaPrompt.measured` (`listed` of `total`, `recentLines`,
`compacted`): first the previous-phase lines are dropped, then each unit's list
is shortened from its end (convoys, then supports, then moves). A unit's HOLD is
never removed, so a reduced catalog always still admits a fully legal answer. If
even that does not fit, the request is refused rather than truncated.

## Measured sizes (offline)

Standard 1901 opening, no previous phase, from `LunaContext.test.ts`:

| | Bytes |
| -- | -- |
| Shared prefix | about 700 |
| Whole context per power | under 2,500 |
| Largest single-power legal catalog in the development fixtures | about 1,150 (a convoy position) |
| Worst-case reservation for one opening call | under USD 0.0016 |

For comparison, the legacy room-game prompts sent the full adjacency graph and
conversation memory on every call. Real token counts, cache hits, latency and
cost can only come from the authorized evaluation (DIC-68); these figures are
byte measurements, not provider usage.

## The decision provider

`LunaDecisionProvider.ts` plugs these requests into the phase coordinator's
`DecisionProvider` seam. For each opponent, in a fixed order and one at a time:

1. A power with nothing to decide gets its forced action; no call.
2. If a validated decision for this phase and power is already stored
   (`provider_decisions`), it is reused and nothing is bought.
3. Earlier calls are reconciled: a never-dispatched call is reused only if it
   reserved exactly this request under the current fence, otherwise it is
   released; a call left dispatched by a run that no longer exists is closed as
   an unknown outcome and its reservation stays held.
4. A new call is reserved through the ledger, sent through `recordedCall` with
   the exact reserved bytes, and its usage is recorded before the answer is read.
5. The answer is mapped to an action, checked by the rules engine, and stored
   before the call is marked finished.

`decide` and `recover` are the same procedure. One run makes at most one new
call per power, matching the preset's zero automatic retries; an explicit
recovery is a new reserved call, limited to three per power per phase. On budget
exhaustion, a pause, a closed attempt, the call limit or an unusable answer the
phase is left recoverable with the player's orders saved. Opponents are never
replaced by holding units.

`Transport.ts` holds the bounded HTTP transport and a deterministic mock that
reads the numbered choices from the request and answers in the provider's
envelope. Neither is constructed at startup: paid operation is still refused by
configuration, and this provider is not yet selected for any attempt.

Crash evidence (`LunaProvider.test.ts`, mock transport): a process killed after
a reservation, after dispatch, after the usage receipt, after a decision is
stored, after all decisions are saved and after commit each recovers to exactly
one phase report, with every known bill in the ledger once, stored answers not
bought again, and the accepted human command still idempotent and never
reopened for editing.
