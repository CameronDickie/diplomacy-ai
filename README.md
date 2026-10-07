# Diplomacy

A browser game of short, scored Diplomacy scenarios: you command one power and
try to take a named supply center before a deadline, on the standard map, with
the [Godip](https://github.com/zond/godip) rules engine adjudicating every
order.

This project's original code is licensed under GPL-3.0-only. See
[LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). The client
links to the [credits and licenses page](client/public/legal.html) and the
[source repository](https://github.com/CameronDickie/diplomacy-ai).

## What works today

- **Public page, no account:** the current scenario's goal, rules and limits,
  and a recorded reference replay you can step through.
- **Signed-in play (GitHub or Google):** start, resume and finish your own
  attempt. Orders are chosen from menus of moves the rules engine allows; the
  server keeps the board, scores settled Fall turns and saves every phase, so an
  attempt survives a browser reload or a server restart.
- **A free practice bot:** scripted opponents that go for supply centers and
  support each other, with no AI model and no cost. Opponents that simply hold
  are also available for learning the controls.
- **A rotating development catalog:** six generated scenarios, one featured per
  UTC day. An attempt keeps the scenario it started with.
- **Limits:** three attempts at once site-wide, one per account, three starts per
  account per UTC day, expiry after 30 idle minutes, and per-route rate limits.
- **Your data:** finished attempts are removed after 30 days; you can delete
  your account and its attempts at any time.
- **Operator view** for the site owner: capacity, attempts, spend totals, a
  read-only board viewer, stop/ban controls and a notification outbox.
- **A separate free local lobby** (the original multi-seat room game with offline
  bots) for development on your own machine.

## What does not work yet

This is a development pilot, not the finished product.

- **No live AI opponents.** Everything needed to play against the server-owned
  `gpt-6-luna` preset is built and tested against a mock: the budget ledger, the
  request contract, bounded prompts, crash recovery and a sponsored attempt
  mode. No call to the real provider has ever been made, and the server refuses
  to start with paid AI enabled until the owner authorizes spend. On a
  deployment today, the opponents are the practice bot or holding units. Locally you can try the sponsored
  flow against a stand-in with `DIPLOMACY_LUNA_TRANSPORT=mock`.
- **The scenarios are test content.** They were generated to exercise rotation
  and scoring; they are short and have not been tuned for difficulty. No public daily schedule
  has been approved, and the UI does not call this a daily game.
- **Nothing is deployed or published** by this repository's automation.
  Deployment, funding, and making the repository public are owner decisions.

Scope, status and release gates live in Linear; see
[docs/public-showcase-tracking.md](docs/public-showcase-tracking.md).

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

- `client/` — React and Vite interface and the SVG board.
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
available to recipients alongside the build. Before launching a public site,
make the linked source repository public or provide an equivalent public source
download for the exact deployed version. Do not publish `.env` or provider
credentials. The personal-site repository and deployment remain separate from
this game project. The JSON-over-stdio process boundary does not itself settle
whether components form a combined work, so this repository uses one
GPL-compatible license for its original code rather than relying on that
boundary for a license exception.
