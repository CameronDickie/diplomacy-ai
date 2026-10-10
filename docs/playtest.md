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
| `DIPLOMACY_PLAYTEST_OPPONENTS=AUSTRIA=haiku,FRANCE=luna` | per-power models. A power the scenario gives to the human is ignored |

A live playtest needs the key of each model in use: `OPENAI_API_KEY` for Luna,
`ANTHROPIC_API_KEY` for Haiku. Each transport is given only its own key.

## Set up

1. Create an env file outside version control, for example `playtest.env`
   (`.env.*` is ignored by git). Do not reuse the root `.env` if it does not
   validate; point the server at this file instead.

   ```
   DIPLOMACY_PROFILE=local
   DIPLOMACY_DATABASE_PATH=/absolute/path/to/diplomacy-ai/data/playtest.sqlite
   DIPLOMACY_AUTH_SESSION_SECRET=<at least 32 random characters>
   DIPLOMACY_DEV_LOGIN=true
   DIPLOMACY_LUNA_TRANSPORT=mock
   DIPLOMACY_SPONSORED_PRESET=luna
   DIPLOMACY_PLAYTEST_OPPONENTS=AUSTRIA=haiku,GERMANY=haiku,RUSSIA=haiku
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

- The brief on the left names every opponent's model and says whether real
  provider calls are being made.
- **Playtest log**, beside the phase reports, lists per model the calls, valid
  answers, average provider time and cost, and per phase each power's model,
  outcome, time, cost and the orders it chose (`LON|MOVE|NTH`).
- The log is built from the accounting records. Prompts and raw answers are
  not stored anywhere.
- `npm run storage -- funding "$PWD/data/playtest.sqlite"` shows what is left.

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
