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

A context must fit `LUNA_PRESET.maxContextBytes` (24,000 UTF-8 bytes) and the
serialized body must fit `maxRequestBytes` (32,768 bytes). Neither byte count is
claimed to bound model tokens: message framing and the response schema can add
tokens that a local tokenizer does not see.

Every call reserves the full accepted input ceiling (32,768 tokens priced at the
cache-write rate) plus all 2,048 capped output tokens: USD 0.00512. The real HTTP
transport then counts the exact model, input, instructions, reasoning, text/schema,
tools, tool choice and truncation through the official input-token endpoint. A
successful positive integer count no greater than the ceiling is required before
model generation. Counting has a five-second deadline and 4 KiB response cap;
there are no automatic retries. The returned sender accepts only the counted bytes
and can be used once. A failed count releases the still-unsent PREPARED reservation;
it never releases a dispatched or uncertain model call.

The provider takes its durable dispatch claim after counting, so stop/ban/current
phase and funding are checked again immediately before generation. A crash between
reservation and counting leaves an unsent hold that recovery can reuse or release.
A crash after counting must count again; only saved, validated game decisions are
reused without another count or model request. This count protocol is documented
by [OpenAI's token-counting guide](https://developers.openai.com/api/docs/guides/token-counting)
and [endpoint reference](https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count).

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
| Worst-case reservation for any call | USD 0.00512 (entire preset ceiling) |

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
4. A new call is reserved through the ledger. HTTP preflight counts the exact
   input; `recordedCall` then takes the dispatch claim and sends those immutable
   bytes. Usage is recorded before the answer is read.
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
envelope. The mock is selectable only in the local profile. The real HTTP transport is
used by the explicitly authorized evaluation CLI; public paid operation is still
refused by startup configuration. Mock usage is a stand-in, not token verification.

Crash evidence (`LunaProvider.test.ts`, mock transport): a process killed after
a reservation, after dispatch, after the usage receipt, after a decision is
stored, after all decisions are saved and after commit each recovers to exactly
one phase report, with every known bill in the ledger once, stored answers not
bought again, and the accepted human command still idempotent and never
reopened for editing.
