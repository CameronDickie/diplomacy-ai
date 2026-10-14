# Game viewer

A development-only page for reviewing full games played by models with no human
player ([autoplay](autoplay.md)). It is at `/viewer` on the development server
and appears in the header as **Game viewer** in the local profile only.

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
  GPT-6 Luna, dashed for Claude Haiku 5.5, ending with a cross where a power is
  eliminated. Click or drag on it to move the board.
- **The board** for the chosen phase: the orders as given, then the result,
  with playback at several speeds. Arrow keys step, space plays and pauses.
- **The turn in words**: each power's orders and whether they worked, the
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
serving; builds and the production server never include or serve it. A later
public version would need its own decision about which games and messages to
publish.
