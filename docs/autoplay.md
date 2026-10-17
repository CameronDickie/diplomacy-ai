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

For each orders phase, three rounds of calls share one five-minute deadline.
Each call may take 40 seconds (the challenge allows 20, because a visitor is
waiting there; an unattended game would rather wait than leave a call's outcome
unknown and its worst-case cost held):

1. **Messages.** Every power with units gets one call. It may write one
   message to each of up to three other powers (`--messages N`, 0 turns this
   off), or to nobody.
2. **Replies.** Every power that was written to gets one call and answers each
   power that wrote to it.
3. **Orders.** Every power gets its orders call. Its request now includes its
   own messages, sent and received, from this turn and earlier ones. The answer
   names each unit beside the number chosen for it
   (`{"orders":[{"unit":"PAR","choice":12}, …]}`), and each number must come
   from under that unit's own heading. The first live game used a bare list of
   numbers here; once a power had many units, GPT-6 Luna repeatedly gave one
   unit two numbers and another none (12 rejected answers, none from Haiku).

Retreat and build phases have only the decision round.

An orders answer the rules allow can still have a power's own moves fail
against each other: two of its units sent to the same place (only one can
arrive), or a unit sent into a place its own unit is not leaving. The
instructions forbid both, and the request marks moves two units share, but in
the fourth live game GPT-6 Luna did it in half of its turns once a power had 14
or more units; Turkey, one center from winning, sent 9 of its 16 units into
places another Turkish unit was also going. Such an answer is now refused once:
the retry names the units that clash (for example "your units in ANK and SMY
were all sent to ARM, where only one can arrive"). The second answer is played
as given, whatever it says. The refused answer is billed like any other and
listed under `record.failures`; `run.harness.askAgainWhenBlocked` records that
the check was on.

### Memory: threads and notes

Since version 7, a power writing to or answering others sees its whole
conversation with each of them, one thread per power (12,000 bytes shared,
newest kept if longer). With its orders it also writes itself a private note
(`{"orders":[…],"note":"…"}`, at most 300 characters kept), and its recent
notes are shown back to it in every later request. Notes are stored with the
call that produced them (table `power_notes`), only for accepted answers, and
exported per phase under `record.phases[].notes`.

### Fall captures, and moves that clash

Since version 6, in a Fall orders turn every request says which supply centers
change hands if the units on them stay, a power's own list names the centers
it is about to take, and each order of such a unit says whether it keeps or
gives up the center. In full games the notes on moves two of a power's units
could both make ("shared with") are kept in every request; other parts of a
long request are cut first.

### Winning, and convoys

Since version 5 of the harness (see [harness-changes.md](harness-changes.md)),
full-game instructions say that only a solo win counts: ending without 18
supply centers is a loss, the same as being eliminated. They also explain
convoys (a fleet at sea orders the convoy, the army the move by convoy, in the
same turn; a fleet in a coastal province cannot convoy). In the list of
orders, an army's move by convoy names the fleet that must convoy it and a
fleet's convoy names the army move it needs; before the list, each army on a
coast gets up to two lines naming a fleet move this turn that would open a
convoy next turn. These hints are the first thing dropped if a request is too
large. An answer whose convoy is missing its other half is asked about once,
like orders that block each other.

### The hold rule

The standing orders instructions are the challenge's, with two differences:
powers are told that the others play for themselves and may write to them, and
the rule about holding is worded differently.

The challenge says to hold a unit "only when it sits on one of your supply
centers that another power could reach this turn, or when it has no useful
move". In the first three live games Claude Haiku 5.5 held about 84% of its
orders whichever powers it played. Nine in ten of those holds were on its own
supply centers, and about half of those had a foreign unit next door, which is
what that wording permits. Late in a game nearly every center is within some
rival's reach.

From the fourth game on, a full game says instead that holding is the
exception, that a rival unit next to a center is not by itself a reason to
hold, and that a center is only lost if a rival stands on it at the end of a
Fall turn. Nothing else in the instructions changed with it, so the fourth
game's hold rate can be read against the first three. The record's
`run.harness.instructionsHash` tells the two wordings apart; games recorded
before that field existed used the old one.

What a power is shown:

- the public board and last phase's public results, the same for everyone,
  with the standings said outright (each power's supply-center count, and how
  far the leader is from 18);
- only messages it sent or received, never what two other powers said to each
  other, newest kept within a 6,000-byte budget;
- its own numbered legal choices. Having exchanged messages with a power this
  turn, it is also offered orders that support or convoy that power's units,
  so an agreement can actually be carried out.

A message or reply call that fails, or returns something unusable, is tried
again at once: up to two more times by default (`--message-retries N`, 0–3).
After that the power says nothing that turn and the game goes on. Every failed
try is billed, printed as it happens, listed under `record.failures` with the
power, the try number and the reason, and kept in that phase's `talk[]` with
its outcome. The reason is the call's recorded outcome: `INVALID_JSON`,
`INVALID_ACTION` (valid JSON of the wrong shape), `TIMEOUT`, `PROVIDER_ERROR`
(the provider answered with an error status), `REFUSED`, `INCOMPLETE`,
`TRANSPORT_ERROR` (no answer at all) or `PREFLIGHT` (the token count failed, so
nothing was sent or billed). Raw provider error text is never stored, so the
reason is a category, not a message.
An orders answer that cannot be used (outcome `INVALID_ACTION`) is explained the
same way, for example "F BRE was given more than once; no usable order for
A TUN" or "41 is not one of the numbers under A GAS (those are 45 to 61)". The
answer itself is not kept.

The next try for that power is not the same request again: it ends with one
server-written line saying what was wrong ("Your previous answer for this turn
could not be used: 16 numbers for 16 units; nothing for A TUN; more than one for
F BRE") and listing the units it must cover. After a restart the exact reason is
gone, so the line says only that some unit had more than one number and another
none. A power gets up to six orders calls for a phase by default
(`--order-calls`), all of them within one run.
A `PREFLIGHT` failure carries the reason the token count could not be had, for
example `PREFLIGHT (HTTP 429)` (rate limit or quota), `HTTP 401` (key refused)
or `no answer in time`. Nothing was sent, so nothing was billed. When a phase
fails this way the tool waits before trying again (5, 10, 20 … up to 60
seconds), because a provider that is refusing requests is not helped by asking
faster. These waits do not use up the phase's recoveries: it waits up to twelve
times, about ten minutes, before stopping. A failed connection is logged with
the system's short code when there is one, for example
`PREFLIGHT (no connection, ENOTFOUND)`.
Running out of funds or a stop still halts the phase, as for a decision. An
orders call that fails leaves the phase waiting and is recovered, up to the
usual three calls per power; no power is ever given a default in place of its
model's decision.

Requests are capped at 24,000 bytes of context. When a request would not fit,
recent results go first, then the message history is cut to a quarter and then
dropped, then each unit's list of supports and convoys is shortened. So request
size grows over the first years and then levels off. The record lists the
provider-counted input tokens of every call, which is how to see that curve.

## When a game ends

One of three ways, whichever comes first:

- **A solo win.** After a Fall turn (and its retreats) the rules engine counts
  supply centers; a power owning 18 of the 34, which is more than half, has
  won and the game stops there, before that winter's builds.
- **The last year.** `--until YEAR` (default 1908): the game stops once that
  year's Fall has settled. `--until win` removes the year as a stopping point.

- **A stalemate.** `--stalemate-years N`: the run stops once no supply center
  has changed hands for N years. It is 10 by default with `--until win`, and
  off otherwise; 0 turns it off. The game itself is left as it stands, so
  running again with a larger number (or 0) plays on, and running again with
  the same number reports the stalemate again without buying anything. The
  longest quiet stretch in the first three live games was four years.

The summary's `endedBy` says which: `SOLO_WIN`, `LAST_YEAR` or `STALEMATE`.

## Running it

`scripts/autoplay.sh` is the ready-made way to run it on this machine. It sets
the development profile, creates `data/autoplay.sqlite` on first use, and for a
live run reads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from `playtest.env` if
they are not already in your environment (only those two lines; the file is not
sourced and nothing is printed). It never records a funding grant; that stays
your own command. Everything after the script name is passed to the tool:

```bash
npm run build
scripts/autoplay.sh --run trial-1 --until 1903          # creates the database, then asks for a grant
npm run storage -- grant "$PWD/data/autoplay.sqlite" 5 autoplay-0001
scripts/autoplay.sh --run trial-1 --until 1903 --attempt-cap 5
```

The same by hand, which is also what the rest of this page uses.
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
| `--until YEAR` or `--until win` | the game ends after this year's Fall (default 1908) or on a solo win, whichever is first. `win` plays until a power has 18 centers: there is no year limit to speak of (it stops at 1999), so a game with no winner ends as a stalemate (below), on Ctrl-C, or when its spending cap is reached |
| `--models POWER=sol` or `POWER=sonnet` | besides `luna` and `haiku`, a power can be played by GPT Sol 6.1 (`sol`) or Claude Sonnet 5.5 (`sonnet`), each provider's stronger model. They use the same requests, limits and schemas as Luna and Haiku, and the same keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Both cost twenty times as much per token ($2 per million input, $10 output), so a game to 1950 is likely USD 25–40; raise `--attempt-cap` and record funds first. They are for full games only: the server's configuration still accepts only `luna` and `haiku` |
| `--effort low\|medium\|high` | the reasoning effort every request of the game is sent at (default `low`, as in the challenge). Higher effort raises each call's output ceiling (reasoning counts toward it), the worst case reserved per call, and the time limits (90 s per call and 10 minutes per phase at `medium`, 120 s and 10 minutes at `high`). A game keeps one effort: continuing it with another is refused |
| `--stalemate-years N` | end the run once no supply center has changed hands for N years (default 10 with `--until win`, otherwise off; 0 is off) |
| `--models AUSTRIA=luna,ENGLAND=haiku` | per-power models. Default: Austria, France, Italy, Turkey on Luna; England, Germany, Russia on Haiku |
| `--messages N` | how many powers each power may write to per turn (0–6, default 3) |
| `--message-retries N` | further tries for a failed message or reply call (0–3, default 2) |
| `--order-calls N` | orders calls one power may use for one phase, counted across every run (3–10, default 6). A game stuck because a power's answers were unusable continues when run again with a higher number |
| `--resume-paid` | lift the pause the ledger sets when a grant runs out, after you have recorded a new grant |
| `--max-phases N` | stop cleanly after N phases; continue later with the same run id |
| `--attempt-cap USD` | per-game spending cap |
| `--out FILE` | where the record goes (default `autoplay-ID.json` in the current directory, which git ignores) |
| `--live --authorization-ref REF` | call the real providers; see below |

A game is not started against a ledger that is paused or has too little to
cover one round of calls; it says so and changes nothing. If a grant runs out
mid-game the ledger pauses, the game waits with everything bought so far kept,
and it continues after a new grant and one run with `--resume-paid`.

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

One JSON file, readable only by you (it holds no keys and no game requests):

- `run`: run id, transport, last year, message limit, the model of each power,
  the context version, and `harness`: the code commit the run was played with
  (and whether code differed from it), the standing orders instructions with a
  short fingerprint, the call time limit and the stalemate limit. Two games
  with the same fingerprint were given the same rules of play. A continued
  game states the latest run's values. The commit is `null` where there is no
  git checkout, such as inside the container.
- `status`, `endedBy` and `waitingOn`: `FINISHED` and how it ended, or why it
  is not finished and what to do.
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
- `record.failures`: every failed message or reply try (power, try number,
  reason, whether it gave up), and why any phase had to wait, with times.

A game continued over several runs has one file per run. `npm run records -- collect FILE...`
combines them for the [game viewer](game-viewer.md).

Game requests (the board text sent each turn) and the models' reasoning text are
not stored anywhere, so they are not in the record; the standing instructions,
which are the same every turn, are. Token counts, including reasoning tokens, are.

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
