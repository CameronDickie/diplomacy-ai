# Luna decision context

`server/src/luna/` turns one frozen phase into, at most, one bounded request per
opponent power, and turns the model's answer back into an action the rules
engine then checks. It contains no transport and makes no provider call.

## What a request contains

`Context.ts` (`luna-context-v6`) writes plain text in two parts:

1. **Shared prefix**, identical for all six opponents in a phase so the provider
   can cache it: season and phase, the scenario's pinned objective, supply
   centers by power, units by power, and up to 40 lines of the previous phase's
   public results.
2. **Own section**: "You are FRANCE"; that power's private conversation with
   the human player if there is one (development playtests only, most recent
   messages within 3,000 bytes, each on one line); the rule for how many numbers
   to pick; and that power's numbered choices grouped by unit.

It is built only from the frozen public board, the challenge definition and the
last public report. The human player's accepted orders (`PhaseJob.humanAction`)
and other opponents' saved decisions are never read, and one power never sees
another power's options. There is no map topology, chat or memory.

## Standing instructions

Every opponent, whatever the model, receives the same instructions
(`providers/OpponentInstructions.ts`). They give it a purpose (keep and gain
supply centers; there is no negotiation) and the rules that make a set of
orders hang together: move rather than hold without a reason, never walk into
your own unit that is not leaving, never send two units to one place, and a
support or convoy only counts when the other unit is ordered to match.

They exist because the first human playtest (October 9, 2026) showed both
models choosing each unit's order in isolation and mostly standing still.
Measured on live Haiku games of the Tunis pilot:

| | Old instructions | Current |
| -- | -- | -- |
| Unit orders that were holds | 86 % | 41 % |
| Unit orders that were moves | 12 % | 50 % |
| Supply centers held by the six opponents at game end | 22–29 | 31–33 |
| Order sets with a self-defeating order | about 2 % | about 2 % |

Ten games before, three after; indicative only. Luna has not been re-measured.
The instructions are part of each preset's pinned request, so changing them is
a new preset id (currently `luna-challenge-v5`, `haiku-challenge-v4`).

A second pinned request per model, with its own instructions
(`CHAT_INSTRUCTIONS`), asks for one short reply to the player's latest message.
It uses the same model, limits and prices.

A model-only full game ([autoplay.md](autoplay.md), development only) adds four
more pinned requests per model, with their own instructions: its orders (one
entry per unit), its retreats and builds (a list of numbers), its opening
messages to other powers, and its replies. The transports accept exactly these
six request shapes and refuse anything else. The two challenge requests
are byte-for-byte what they were, so the preset ids did not change.

## Choices

`Choices.ts` numbers what a power may do; the model returns `{"choices":[…]}`.

| Phase | Listed | Must pick |
| -- | -- | -- |
| Orders | the legal orders that can serve this power, per unit: moves, then supports and convoys, then HOLD last | exactly one per active unit |
| Retreats | disband, then each legal destination (with coast) per dislodged unit | exactly one per dislodged unit |
| Builds | army and fleet (per coast) for each free owned home center | up to the allowance, one per center; empty waives. When there are more free centers than builds the rule says so in words, because models otherwise picked one per center |
| Disbands | each of the power's units | exactly the required number |

### Which orders are offered

Godip's catalog lists every legal order, including many that cannot help the
power choosing. Before numbering, the list is reduced using public board facts
only:

- **No orders for another power's units**, unless this power has a
  conversation with the human player, in which case orders that help the
  player's units are offered so an agreement can be carried out.
- **No support where nobody else can reach.** A support for one of your own
  units is offered only if another power's unit occupies the territory or could
  move there this turn. Every power's legal moves are computed once per phase
  from the public board to decide this; nobody's submitted orders are used.
- **Every hold and every move is kept**, so a fully legal answer always exists.

Each move also says what it reaches: whose supply center it is, and whether a
unit is there (`KIE moves to DEN (unowned supply center)`). Two further notes
are added when the complete request has room for them, and are the first thing
dropped when it does not:

- a move that another of the power's units could also make says so
  (`ROM moves to TUS (shared with A VEN)`), with one line in the rule explaining
  that only one of them should be sent. In the live full games GPT-6 Luna
  ordered two of its units to one place 25 times in a game;
- a support or convoy for another power's unit names the owner
  (`AEG supports ION holding (TURKEY's unit)`).

In a model-only full game the shared text also states the score:
`Standings (18 supply centers win): ITALY 17, ENGLAND 11, …`, and once one power
is clearly ahead with ten or more, how many it still needs and that everyone
else loses if it gets them. In the second live game a power reached 17 without
any other treating it as a threat.

`coherenceIssues` in `Choices.ts` classifies order sets that still work against
themselves (a move into your own stationary unit, two units to one place, an
unmatched support or convoy). These are legal, so they are not rejected; they
are counted in the playtest log and used to compare versions.

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
