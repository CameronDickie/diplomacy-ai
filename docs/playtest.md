# Local playtest mode (development only)

Play the challenge in your browser against real models on your own machine,
with different models on different powers in the same game, and see which
model chose which moves, how long it took and what it cost.

**This is a development tool. It is not how players will ever reach a model.**
Every switch below is refused by the configuration contract unless all of
these hold, and the server refuses a hand-built configuration the same way:

- the profile is `local`;
- it is not a production build (`local` cannot be one at all);
- for live calls, per-power models and the development sign-in: `HOST` is a
  loopback address, so nothing off this machine can reach it.

The public paid-startup refusal (`DIPLOMACY_PAID_AI_ENABLED`) is untouched and
is not used by this mode.

## What it adds

| Setting | Effect |
| -- | -- |
| `DIPLOMACY_DEV_LOGIN=true` | a "Continue as local developer" button; no GitHub or Google app needed. The account is an ordinary player and can never be an operator |
| `DIPLOMACY_LUNA_TRANSPORT=live` | sponsored attempts call the real providers, through the funding ledger. `mock` uses the free stand-in instead |
| `DIPLOMACY_SPONSORED_PRESET=luna\|haiku` | the model for every opponent not named below |
| `DIPLOMACY_PLAYTEST_CHAT=true` | a private chat with each opponent power; every message is answered by that power's model ([below](#talking-to-the-opponents)). Needs a `mock` or `live` transport |
| `DIPLOMACY_CHAT_MESSAGE_LIMIT=30` | messages you may send in one attempt (1–200) |
| `DIPLOMACY_PLAYTEST_OPPONENTS=AUSTRIA=haiku,FRANCE=luna` | per-power models. A power the scenario gives to the human is ignored |

A live playtest needs the key of each model in use: `OPENAI_API_KEY` for Luna,
`ANTHROPIC_API_KEY` for Haiku. Each transport is given only its own key.

## Set up

1. Create an env file that git ignores, for example `playtest.env` (`*.env`
   and `.env.*` are ignored). It will hold provider keys: run `git status`
   and confirm it is not listed before committing anything. Do not reuse the root `.env` if it does not
   validate; point the server at this file instead.

   ```
   DIPLOMACY_PROFILE=local
   DIPLOMACY_DATABASE_PATH=/absolute/path/to/diplomacy-ai/data/playtest.sqlite
   DIPLOMACY_AUTH_SESSION_SECRET=<at least 32 random characters>
   DIPLOMACY_DEV_LOGIN=true
   DIPLOMACY_LUNA_TRANSPORT=mock
   DIPLOMACY_SPONSORED_PRESET=luna
   DIPLOMACY_PLAYTEST_OPPONENTS=AUSTRIA=haiku,GERMANY=haiku,RUSSIA=haiku
   DIPLOMACY_PLAYTEST_CHAT=true
   # For DIPLOMACY_LUNA_TRANSPORT=live, add the keys for the models in use:
   # OPENAI_API_KEY=...
   # ANTHROPIC_API_KEY=...
   ```

   Use absolute paths for the database here and for the env file below: the
   API runs from the `server/` directory, so relative paths would not mean the
   same file to every command.

2. From the repository root, build, create the database and record a grant.
   The grant is what the game may spend; with `mock` it is only a number.

   ```bash
   npm run build
   mkdir -p data
   npm run storage -- init "$PWD/data/playtest.sqlite"
   npm run storage -- grant "$PWD/data/playtest.sqlite" 1 playtest-0001
   ```

3. Start the API and the client in two terminals, both from the repository
   root.

   ```bash
   DIPLOMACY_ENV_FILE="$PWD/playtest.env" npm start
   ```

   ```bash
   npm run dev -w client
   ```

4. Open `http://localhost:5173/challenge`, choose **Continue as local
   developer**, then **Play against mock model opponents** (or **Play a live
   playtest** when the transport is `live`).

Start with `mock` to see the flow for free, then switch the one line to `live`
and restart the API. An attempt keeps the assignment it started with: after
changing models, start a new attempt.

## Reading a game

- **Your orders** from the last turn, and whether each succeeded, are listed
  above the order menus.
- A convoy needs two orders: the army's "moves ... by convoy" and a fleet's
  "convoys ...". Choosing the army's sets the fleet's when only one fleet can
  carry it, and a warning shows whenever the two do not match.

- The brief on the left names every opponent's model and says whether real
  provider calls are being made.
- **Playtest log**, beside the phase reports, lists per model the calls, valid
  answers, average provider time and cost, and per phase each power's model,
  outcome, time, cost and the orders it chose (`LON|MOVE|NTH`).
- An order set that works against itself (for example a support for a move
  that was not ordered) is flagged in the log, with a count per model.
- The log is built from the accounting records. Prompts and raw answers are
  not stored anywhere.
- **Download the full game record** in the playtest log saves one JSON file
  with every phase's public report, each opponent call (model, decision,
  outcome, time, tokens including reasoning tokens, cost, self-defeating flags),
  your conversations with timestamps, and why any turn had to wait. Prompts and
  the models' reasoning text are not stored, so they are not in it.
- When a turn is waiting on an opponent, the notice beside your orders lists
  what happened (which power, which model, which outcome, after how long), and
  the API console prints the same line. This detail exists only in development
  and is kept in memory, so it does not survive a restart.
- `npm run storage -- funding "$PWD/data/playtest.sqlite"` shows what is left.

## Talking to the opponents

With `DIPLOMACY_PLAYTEST_CHAT=true`, a sponsored attempt shows **Talk to the
other powers**: one private thread per opponent.

- You write; that power's own model replies, in character, in a few seconds.
  Opponents only reply. They do not start conversations or talk to each other.
- Each opponent sees **only its own thread with you** when it chooses orders,
  alongside the board. It is told the conversation is negotiation, not
  instructions: it may keep an agreement or break it.
- Having talked with you, a power can be offered orders that help your units
  (supporting or convoying them), so an agreement can actually be carried out.
- You can send messages while you are choosing orders, up to the per-attempt
  limit. A message is at most 500 characters.
- If a reply cannot be produced, your message stays and is marked as
  unanswered. It still counts toward the limit.
- With the `mock` transport the replies are labelled stand-ins.

What is stored and guaranteed:

- A message is stored once per send, even if the request is retried, and buys
  at most one reply. Reusing a send's id for different text is refused.
- A reply is a reserved, recorded call through the same funding ledger as an
  order decision, on that power's pinned model and price list.
- Your text reaches the model as one line of quoted conversation between a
  fixed heading and the fixed rules. It cannot add choices or instructions.
- Threads belong to the attempt's owner, are not in replays or the operator
  views, and are deleted with the attempt or the account.

### What chat costs (Haiku, measured live October 11, 2026)

One attempt of the Iberian pilot, all six opponents on `claude-haiku-5-5`,
30 messages of about 330 characters, five or six to each power:

| | Measured |
| -- | -- |
| One reply | about USD 0.00024 (2 to 3 seconds) |
| All 30 replies | USD 0.0071 |
| One turn of opponent orders, no conversation | USD 0.00135 |
| The same turn with all six conversations in view | USD 0.00261 |

So the cases are roughly:

- **Never chats:** about USD 0.02 a game, as before.
- **Uses every message, at length, with everyone:** about USD 0.007 for the
  replies, plus about USD 0.0013 extra on every later turn because each
  opponent re-reads its thread. Over a ten-turn game that is about USD 0.04 in
  all, roughly double.
- **Hard ceiling:** each reply reserves its model's worst case first (under
  one cent), so 30 messages can never reserve more than about USD 0.26.

The thread shown to a model is capped at 3,000 bytes (the most recent
messages), which is what bounds the per-turn extra. Luna has not been measured;
its price list is the same per token, so expect the same order of magnitude,
and the playtest log shows replies and their cost per model as you play.

## What it costs and how it is bounded

Each opponent decision reserves its model's worst case first (under one cent)
and settles at the real cost. From the live baselines, a whole Haiku attempt
cost about a cent. The game stops asking when the grant is used up; it never
substitutes holds for a model's decision.

## Limits

- One scenario at a time, six opponents, one decision per power per phase.
- Mock opponents choose seeded-random legal moves; they say nothing about
  either model.
- The Luna live path through the server uses the same transport as the Luna
  evaluation, but a live Luna playtest has not been run from here.
- A mixed game is not an evaluation run: its figures are for comparing
  behaviour by eye, not for the launch targets ([evaluation.md](evaluation.md)).

## Verification

`server/src/test/Playtest.test.ts`: each switch refused in showcase, private,
production and on a non-loopback host; a forged configuration refused by the
server; the sign-in route absent unless enabled, and never an operator; a mixed
mock game with each call recorded under its own model and reservation; the log
owner-only and absent without a development transport; and a live mixed game
against unreachable providers, which contacts only each provider's token-count
endpoint with its own key and spends nothing.
