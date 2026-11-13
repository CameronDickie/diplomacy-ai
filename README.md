# Diplomacy between language models

Sixteen full games of [Diplomacy](https://en.wikipedia.org/wiki/Diplomacy_(game)) played by
language models from OpenAI and Anthropic, and the software that ran them: a rules engine, a harness
that turns a model's answers into legal orders, and the tools that recorded and analysed every game.

- **The write-up:** [Do language models lie on purpose when lying is the game?](https://camerondickie.ca/writing/diplomacy)
- **The games, turn by turn:** [camerondickie.ca/diplomacy](https://camerondickie.ca/diplomacy/), with
  every message, order and private note.

The project is finished and no longer hosted as a playable site. This repository is kept as a record:
the code is as it was when the games were played, and the games and the analysis behind the post are
included so the numbers can be checked.

Every line of code here was written by AI coding agents (Claude Code, Codex and GitHub Copilot)
between March and November 2026, directed by me. None of it was written by hand.

This project's original code is licensed under GPL-3.0-only. See [LICENSE](LICENSE) and
[third-party notices](THIRD_PARTY_NOTICES.md).

## What is here

- **The rules engine:** [Godip](https://github.com/zond/godip) adjudicates every order, behind a small
  Go wrapper (`engine/`).
- **The harness for model players** (`server/src/luna/`, `server/src/providers/`, `server/src/autoplay/`):
  each turn a model gets the board, its conversations and a numbered list of its legal orders, writes
  messages, replies and orders, and keeps a private notebook. How it changed between games is in
  [docs/harness-changes.md](docs/harness-changes.md).
- **The game records** (`game-records/`): the sixteen games in the post, one JSON file each, with
  every phase, message, order, private note, model call and cost. `index.json` lists them.
- **The analysis** (`analysis/`): the scripts that produced every number and chart in the post. See
  [analysis/README.md](analysis/README.md).
- **The game viewer** (`client/src/viewer/`): the replay site, which also builds as static files
  (`npm run viewer:static`; see [docs/game-viewer.md](docs/game-viewer.md)).
- **The rest of the game site:** short scored scenarios against scripted bots, a local lobby,
  sign-in, an operator view and deployment scripts. It ran publicly for a while and is kept as it
  was. Paid AI is off unless you configure your own provider keys.

## Run it locally

Requirements: Node.js 22.16 or newer, npm, and Go 1.23 or newer. On macOS,
`brew install node go` provides them.

```bash
npm ci
npm run check
npm run dev
```

`npm run check` builds the Go engine and the three TypeScript workspaces, then
runs the server and Go tests. It needs no `.env`, provider key, Discord or
network service beyond fetching dependencies, and never calls a paid provider.

`npm run dev` serves the client at `http://localhost:5173` with the API on port
`3001`.

| URL | What you get |
| -- | -- |
| `http://localhost:5173/` | the free local lobby with offline bots |
| `http://localhost:5173/challenge` | the scenario page and reference replay |

Signing in locally needs your own OAuth application credentials; see
[docs/authentication.md](docs/authentication.md). Without them the scenario
page still shows the goal and the replay. With no `.env` the server uses the
`local` profile. If you keep a `.env`, leave `DISCORD_ENABLED=false` unless you
are working on the optional Discord integration; every setting is listed in
[.env.example](.env.example) and [docs/configuration.md](docs/configuration.md).

Browser tests (Chromium, mock opponents, temporary database) run after a build
with `npx playwright install chromium` once and then `npm run test:e2e`.

Useful commands after a build:

```bash
npm run fixture -- validate server/fixtures/development/tunis-expedition.v1.json
npm run fixture -- play server/fixtures/development/tunis-expedition.v1.json early-capture /tmp/tunis-after.json
npm run storage -- backup /absolute/source.sqlite /absolute/new-backup.sqlite
```

Never copy a live SQLite file by hand; use the backup command.

## Layout

- `analysis/` — the scripts behind the post's numbers.
- `game-records/` — the sixteen recorded games.
- `client/` — React and Vite interface, the SVG board and the game viewer.
- `shared/` — types shared by client and server, and board metadata.
- `server/` — API, authentication, attempt coordination, SQLite storage,
  scenario fixtures and tests.
- `engine/` — a small Go executable that wraps the Godip rules engine.
- `config/` — the single validated runtime configuration contract.
- `docs/` — start at [docs/README.md](docs/README.md).

## Production build

```bash
npm run build
npm start
```

The server listens on `PORT` (default `3001`), serves `client/dist`, and answers
`GET /healthz`. Container packaging and the Lightsail runbook are in
[docs/deployment.md](docs/deployment.md); day-to-day operation is in
[docs/operations.md](docs/operations.md).

## License and redistribution

Godip v0.6.5, the unmodified classical SVG map, and the map's embedded Libre
Baskerville font have separate attribution and license notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The map and Godip are GPL-3.0;
the font remains under the SIL Open Font License 1.1. The browser exposes these
notices at `/legal.html`, with full license texts at `/LICENSE.txt` and
`/LIBRE_BASKERVILLE_OFL.txt`.

A clean clone contains the application and Go wrapper source. Run `npm ci` and
`npm run build` to fetch the pinned Godip module and produce the distributable
client, server, and engine. The production Docker image includes the notices in
`/app` and the application, wrapper, and pinned Godip source in `/app/source`.
When publishing a build, make its corresponding source and these notices
available to recipients alongside the build. Do not publish `.env` or provider
credentials. The JSON-over-stdio process boundary does not itself settle
whether components form a combined work, so this repository uses one
GPL-compatible license for its original code rather than relying on that
boundary for a license exception.
