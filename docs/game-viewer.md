# Game viewer

A development-only page for reviewing full games played by models with no human
player ([autoplay](autoplay.md)). It is at `/viewer` on the development server
and appears in the header as **Game viewer** in the local profile only.

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

- **New game** offers the autoplay command's choices: a model per power
  (Luna, Haiku, Sol, Sonnet), when it ends (a year, or a win with the
  ten-year stalemate stop), reasoning effort, how many powers each may write
  to, and stand-in or live models. A live game also asks for the funding grant
  that authorizes it and a per-game cap (at most USD 15), and warns if the
  server lacks a provider's key. The page shows each provider's budget.
- **In the database** lists every full game: those the autoplay command played
  and those started here. Opening one shows the usual viewer, with its status
  above: being played (the page refreshes every few seconds and follows the
  newest turn), paused or waiting (with the reason, and **Continue**), or
  finished. **Stop after this phase** works like Ctrl-C. A continued game keeps
  its models, effort and end; the log of the run is shown below the status.
- One game is played at a time.

Live games use the same ledger as the autoplay command (`data/autoplay.sqlite`,
or `DIPLOMACY_AUTOPLAY_DATABASE`), so its budgets and checks apply unchanged.
Stand-in games are kept in a separate database with pretend funds
(`data/autoplay-stand-in.sqlite`, or `DIPLOMACY_STAND_IN_DATABASE`) so their
simulated costs never touch the real ledger; a stand-in game continues with
stand-ins and a live game with live models. A game's settings are read back
from its own calls, and the failures of a run are kept only by the server that
ran it. The service exists only in the local profile; every request that
starts or stops a game needs a trusted browser origin, and the server listens
only on this machine.

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
publish.
