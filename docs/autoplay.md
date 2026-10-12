# Autoplay: a full game with a model on every power (development only)

One whole game from the standard 1901 opening with no human player. Every
power is decided by a model, the powers write to each other before each set of
orders, and everything that happened is exported as one JSON file. It exists to
stress the challenge harness over a long game: the funding ledger, the pinned
requests, the bounded context and recovery.

**This is a development tool.** It is a command-line program that works on a
database file you name. There is no server route and no page for it, and it
refuses to start unless the profile is `local`
(`DIPLOMACY_PROFILE=local`, which is also the default outside a production
build). The public paid-startup refusal is untouched and not used.

## Which harness this is

The repository has two ways of asking a model to play. Autoplay uses the
challenge one.

| | Hosted games (`/`) | Challenge harness (`/challenge`, autoplay) |
| -- | -- | -- |
| Code | `server/src/llm/`, `GameRoom` | `server/src/luna/`, `server/src/providers/`, `server/src/attempts/` |
| State | in memory; lost on restart | SQLite; every phase and call is durable and resumable |
| Spending | a configured per-game ceiling, counted in memory | a ledger: each call reserves its worst case first and settles to the real bill; a grant bounds the total |
| What the model returns | free-form orders it writes itself, then validated | numbers picked from a list of legal orders the server built |
| Request | adjacency graph and conversation memory every call | bounded text: board, last results, this power's messages, its choices |
| Models | OpenAI, Gemini, Ollama, chosen per seat | two pinned presets: GPT-6 Luna and Claude Haiku 5.5 |
| Messages between AI powers | yes, multi-turn conversations | **added here**, one message and one reply per pair per turn |
| A failed call | retried by the controller | recorded; the phase waits and is recovered explicitly, never replaced by holds |

## How a turn runs

For each orders phase, three rounds of calls share one two-minute deadline:

1. **Messages.** Every power with units gets one call. It may write one
   message to each of up to three other powers (`--messages N`, 0 turns this
   off), or to nobody.
2. **Replies.** Every power that was written to gets one call and answers each
   power that wrote to it.
3. **Orders.** Every power gets its orders call. Its request now includes its
   own messages, sent and received, from this turn and earlier ones.

Retreat and build phases have only the decision round.

What a power is shown:

- the public board and last phase's public results, the same for everyone;
- only messages it sent or received, never what two other powers said to each
  other, newest kept within a 6,000-byte budget;
- its own numbered legal choices. Having exchanged messages with a power this
  turn, it is also offered orders that support or convoy that power's units,
  so an agreement can actually be carried out.

A power gets **one** message call and **one** reply call per turn. If that
call fails or returns something unusable, the power says nothing that turn; the
call is billed and listed in the record with its outcome, and is not repeated.
Running out of funds or a stop still halts the phase, as for a decision. An
orders call that fails leaves the phase waiting and is recovered, up to the
usual three calls per power; no power is ever given a default in place of its
model's decision.

Requests are capped at 24,000 bytes of context. When a request would not fit,
recent results go first, then the message history is cut to a quarter and then
dropped, then each unit's list of supports and convoys is shortened. So request
size grows over the first years and then levels off. The record lists the
provider-counted input tokens of every call, which is how to see that curve.

## Running it

Always start with the free stand-in models. They exercise every code path and
cost nothing.

```bash
npm run build
mkdir -p data
npm run storage -- init "$PWD/data/autoplay.sqlite"
npm run storage -- grant "$PWD/data/autoplay.sqlite" 5 autoplay-0001
npm run autoplay -- --db "$PWD/data/autoplay.sqlite" --run trial-1 --until 1903 --attempt-cap 5
```

The grant is the most the database may ever spend; `--attempt-cap` is the most
this one game may spend (a new database allows USD 1 per game, the hard maximum
is 15). With stand-in models both are only numbers.

| Option | Meaning |
| -- | -- |
| `--run ID` | names the game. Running again with the same id **continues** it; nothing already bought is bought again |
| `--until YEAR` | the game ends after this year's Fall (1901–1925, default 1908) or on a solo win |
| `--models AUSTRIA=luna,ENGLAND=haiku` | per-power models. Default: Austria, France, Italy, Turkey on Luna; England, Germany, Russia on Haiku |
| `--messages N` | how many powers each power may write to per turn (0–6, default 3) |
| `--max-phases N` | stop cleanly after N phases; continue later with the same run id |
| `--attempt-cap USD` | per-game spending cap |
| `--out FILE` | where the record goes (default `autoplay-ID.json` in the current directory, which git ignores) |
| `--live --authorization-ref REF` | call the real providers; see below |

Ctrl-C finishes the phase in hand, writes the record and leaves the game
resumable. A run cannot be continued with different models, prices or last
year: choose a new run id for that.

### A live run

A live run is refused unless all of these hold: `--live`, a funding grant
recorded in that database under the reference you pass, and the key of each
model in use in the environment (`OPENAI_API_KEY` for Luna, `ANTHROPIC_API_KEY`
for Haiku). Each transport is given only its own key.

Do a one-year live game first. It costs a few cents and proves that both
providers accept the three new request shapes before a long run is paid for.

```bash
set -a; . ./playtest.env; set +a
npm run storage -- grant "$PWD/data/autoplay.sqlite" 5 autoplay-live-0001
npm run autoplay -- --db "$PWD/data/autoplay.sqlite" --run live-smoke --until 1901 --attempt-cap 5 \
  --live --authorization-ref autoplay-live-0001
```

Check the summary: every order call valid, message calls mostly valid, cost
settled and nothing held. Then the real game, with a new run id:

```bash
npm run autoplay -- --db "$PWD/data/autoplay.sqlite" --run live-1 --until 1908 --attempt-cap 5 \
  --live --authorization-ref autoplay-live-0001
```

The same in a container that has no network unless `--live` is given, write
access to one volume only, and only the provider keys:

```bash
scripts/evaluate-in-container.sh autoplay-live storage init
scripts/evaluate-in-container.sh autoplay-live storage grant 5 autoplay-live-0001
scripts/evaluate-in-container.sh autoplay-live autoplay --run live-1 --until 1908 --attempt-cap 5 \
  --live --authorization-ref autoplay-live-0001
scripts/evaluate-in-container.sh autoplay-live fetch autoplay-live-1.json > autoplay-live-1.json
```

### What it may cost

Not measured live. A stand-in game makes about 43 calls per game year with
three recipients (7 message calls, up to 7 reply calls and 7 order calls per
orders phase, plus retreats and builds), so about 350 calls to Fall 1908.
Earlier live challenge attempts settled near USD 0.0004 per Haiku order call;
message calls write more text and will cost more. Expect well under USD 1 for
an eight-year game, and treat that as a guess until the one-year run reports a
real figure. Each call reserves a worst case of about USD 0.005 while it is in
flight, so the available balance should stay a few cents above zero.

## The record

One JSON file, readable only by you (it holds no keys and no prompts):

- `run`: run id, transport, last year, message limit, the model of each power,
  the context version.
- `status` and `waitingOn`: `FINISHED`, or why it is not and what to do.
- `summary`: phases played, where the game stands, supply centers, winner if
  any, call counts, messages sent, cost settled and held, and the largest
  request of each kind in input tokens.
- `record.phases[]`: for each phase, the public report (every power's orders
  and results, before and after boards), then
  - `calls[]`: one per power's decision: model, outcome, provider time, input,
    output and reasoning tokens, cost, the orders chosen, and any orders that
    work against each other;
  - `talk[]`: one per message or reply call: power, model, round, outcome,
    time, tokens, cost, and the messages themselves with their recipients.
- `record.models`: totals per model, decisions and messages counted apart.
- `record.failures`: why any phase had to wait, with times.

Prompts and the models' reasoning text are not stored anywhere, so they are not
in the record. Token counts, including reasoning tokens, are.

## What this does not tell you

- Whether a model keeps its word. The record has what was said and what was
  ordered; comparing them is analysis, not something the harness scores.
- Anything about long conversations. A pair exchanges at most one message and
  one reply per direction per turn.
- Anything about a human in the game. The challenge's own chat (a player
  writing to an opponent) is separate and unchanged.
- How the challenge presets behave. A full game uses its own instructions,
  which say that every power is a separate player and that messages are
  negotiation; the challenge instructions are unchanged, and so are their
  preset ids.
