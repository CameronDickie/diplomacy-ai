# Game viewer

The AI games part of **Games**: reviewing full games played by models
([autoplay](autoplay.md)), and playing one of the seats yourself. It is at
`/viewer` (the library, **AI games**) and `/viewer#/new` (**Play the AI**), and
is reached from the Games home's Play against the AI and Watch AI games cards.
It runs in the local profile only for now.

## Starting and watching games from the page

The development server can play full games itself, so a game can be started,
watched as it is played, stopped and continued from the browser instead of the
terminal.

```bash
scripts/dev-games.sh
```

starts the development server and client with the local profile and, for live
games, the two provider keys read from `playtest.env` (only those two lines;
nothing is printed). Then open `http://localhost:5173/viewer`.

- **Play the AI** (`#/new`) offers the autoplay command's choices, player
  first: your power (one is picked at random; choose Nobody to let the models
  play alone), one model for every opponent or a model per power (Luna, Haiku,
  Sol, Sonnet), the game length (a year, or a win with the ten-year stalemate
  stop), and stand-in or live models. The game name, reasoning effort and how
  many powers each may write to are under More settings. A live game also asks
  for the funding grant that authorizes it and a per-game cap (at most USD 15),
  shows each provider's budget, and warns if the server lacks a provider's key.
- **AI games** (the library) lists every game once: a saved record and the same
  game in the database are one row, opened live from the database when it is
  there. Your games against the AI come first. Opening one shows the usual
  viewer, with its status above: being played (the page refreshes every few
  seconds and follows the newest turn), paused or waiting (with the reason, and
  **Continue**), or finished. **Stop after this phase** works like Ctrl-C (in
  your own game it reads **Pause the game**). A continued game keeps its
  models, effort, message limit (including messages disabled), transport and end;
  the log of the run is shown below the status.
- One game is played at a time.

Live games use the same ledger as the autoplay command (`data/autoplay.sqlite`,
or `DIPLOMACY_AUTOPLAY_DATABASE`), so its budgets and checks apply unchanged.
Stand-in games are kept in a separate database with pretend funds
(`data/autoplay-stand-in.sqlite`, or `DIPLOMACY_STAND_IN_DATABASE`) so their
simulated costs never touch the real ledger; a stand-in game continues with
stand-ins and a live game with live models. New games save their original
settings before any provider calls; older games use best-effort inference from
their calls. The failures of a run are kept only by the server that ran it.
The service exists only on nonproduction local-profile servers bound to
`127.0.0.1`, `localhost` or `::1`; it is not mounted on network-facing binds.
Every request that starts or stops a game also needs a trusted browser origin.
These are local-owner tools, not authenticated public-player endpoints.
To run a second development server beside the usual one,
give it another `PORT` and start the client with the same port in
`DIPLOMACY_API_PORT`.

### Playing a seat yourself

**Your power** on the Play the AI form puts you in place of one power's model;
the other six are played as usual. The game then waits for you each phase, as
long as you need (up to a week per phase), and the game's page shows a
**Your turn** panel above the viewer: the board now, with your planned orders
drawn on it, and two tabs.

- **Messages** is a chat list: one conversation per power, holding everything
  said between you over the whole game. Powers that wrote to you this turn come
  first, marked **New** until you open them; any other power can be opened to
  start a conversation. Each turn you may send one message to each power still
  in the game (up to 500 characters): **Send** (or Enter) in a chat posts it
  there as not delivered yet, and you can still edit it. When you are done,
  **Finish writing** delivers everything you sent this turn at once (or nothing),
  and each power you wrote to replies once. When the replies come in the page
  stays where it is; the Orders tab says it is your move.
- **Orders** can be planned while you write; your choices are kept, and are
  submitted once the replies are in. On the map, click one of your units and
  then a highlighted place to move it there (by convoy when only a convoy can
  reach it; the fleet that can carry it is ordered to convoy it). Click the unit
  again to let it go. Friendly-occupied highlighted destinations can be chosen,
  allowing swaps and circular moves. Split-coast moves ask which coast rather
  than silently choosing one. Supports and convoys are chosen in the list.
  Convoy coordination warnings are advisory: an ally can provide a convoy, but
  a promise alone does not submit their orders. A matching convoy route must be
  ordered and survive for the army to arrive. When no
  convoy is possible the panel says why: an army can be convoyed only from a
  coast touching the sea its fleet is in.

Each orders turn:

1. The models write first, to you as well as to each other.
2. You write to anyone you like, then finish writing (or say nothing).
3. The models reply to everyone who wrote to them, you included.
4. You submit your orders while the models choose theirs; they see the whole
   conversation when they decide. Orders are checked against the rules before
   the game accepts them.

What you have read and unsent drafts are kept in this browser for each game.
Accepted messages and orders are saved before the server acknowledges them.
Phase retries and server restarts reuse submitted orders rather than asking
again. Submissions identify the phase being answered, so a stale page cannot
silently submit choices for a later turn. Failed legal-order loads offer a retry
without discarding choices. A player with no units can still build or waive
builds when they own eligible centers.

While you hold a seat in a game that has not ended, the viewer below the panel
shows only what every player can see: the board, the supply-center chart and
each turn's resolved orders. The other powers' messages to each other, their
private notes, the call details, the whole-game statistics and the log's lines
about failed model answers (which quote their intended orders) appear when the
game ends.

Retreats and builds ask only for your orders, and a phase that asks nothing of
you plays on without waiting. **Stop** while the game waits for you stops it at
once (the phase is played again when you continue, keeping what was already
said and decided; the run's log notes that it was interrupted). The library
shows such a game as **Waiting for you**.

The turn is the harness's own, so games with no seat are played exactly as
before. Your seat makes no model calls and costs nothing; its messages are kept
in the game record with the model "You". A seated game is named for its seat
(the challenge id ends in `-seat-france`, for example), so continuing it keeps
you in the same seat.

## Getting games into it

The autoplay tool writes one file per run. A game played over several runs (one
stopped with Ctrl-C and continued, say) has several files. Each file already
holds the whole game up to its own export, read from the database; only the list
of failed or retried calls belongs to its own run.

```bash
npm run records -- collect autoplay-live-1.json autoplay-live-4-holdrule*.json
```

`collect` groups the files by game, combines each group into
`game-records/<run id>.json` (the furthest file, with every run's failures in
time order and a list of the files under `parts`) and rewrites
`game-records/index.json`, the viewer's list. The files given are only read.
Files from different games, or that disagree about turns they share, are
refused. Run it again whenever a game has new files; a game already in the
folder is replaced. The combined files are written without indentation, about
half the size of the originals. `game-records/` is git-ignored.

## What it shows

- **A chart of supply centers** after every phase, one line per power: solid for
  OpenAI's models (GPT-6 Luna, GPT Sol 6.1), dashed for Anthropic's (Claude Haiku
  5.5, Claude Sonnet 5.5), with the model named in the legend, ending with a cross where a power is
  eliminated. Click or drag on it to move the board.
- **The board** for the chosen phase: the orders as given, then the result,
  with playback at several speeds. Arrow keys step, space plays and pauses.
  Land without a supply center is shaded in a softened color of the power
  whose unit last stood there (on every map in the app, not only here), so each
  power's area reads as one region. Striped supply centers still mean a center
  about to change hands.
- **The turn in words**: each power's orders and whether they worked (with the
  private note it wrote that turn, for games from harness version 7 on), the
  messages powers sent each other with each reply, and every call with its
  outcome, tokens, time and cost, plus any failures recorded for that phase.
- **The whole game**: each model's orders by kind (hold, move, support,
  convoy), eliminations (click one to jump there), the peak, and the
  fingerprint of the instructions it was played under.

The address names the game and phase (`/viewer#/live-4-holdrule/262`), so a
turn can be linked to directly.

## How it is served

The records are private game data. The Vite development server serves
`game-records/` at `/game-records/` through a plugin that exists only while
serving; builds and the production server never include or serve it. Games in
the database come from `/api/full-games`, which only a local-profile server has. A later
public version would need its own decision about which games and messages to
publish, plus authenticated game ownership and operator-only paid controls.
This development workflow does not enable public AI games or paid calls in
production.
