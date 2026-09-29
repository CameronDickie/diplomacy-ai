# Diplomacy

This project's original code is licensed under GPL-3.0-only. See
[LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
The interactive client links to the [credits and licenses page](client/public/legal.html)
and the [source repository](https://github.com/CameronDickie/diplomacy-ai).

A browser-based implementation of standard Diplomacy for private games, with a
server architecture designed to support human and LLM-controlled powers.

## Current MVP

- Create a game, choose or randomize a power, share its code, and fill empty
  powers with independently configured LLM seats.
- Resume a human seat after a browser or network reconnect.
- Render and click the actual province geometry instead of an adjacency diagram.
- Pan the map and zoom with buttons or the mouse wheel.
- Select a unit and click an adjacent province to prepare a move order.
- Enter holds, moves, supports, convoys, retreats, builds, and disbands.
- Preserve split-coast movement, retreat, and build choices.
- Adjudicate movement and convoy rules with the pinned Godip engine.
- Exchange private messages with humans or LLM powers.
- Run structured OpenAI-backed diplomacy and phase decisions with validation,
  retry, and deterministic fallback.
- Run the built client and Socket.IO server from one Node process.

Deadlines, persistence, complete engine-generated legal action menus,
additional model providers, remote deployment, and production voice validation
remain active work.

## Requirements

- Node.js 22.12 or newer
- npm
- Go 1.23 or newer

On macOS with Homebrew installed:

```bash
brew install go
node --version
npm --version
go version
```

If Node.js/npm are missing, install them with `brew install node`. The normal
Homebrew installation puts these commands on your shell's PATH; no `GOPATH`
configuration is needed for this Go module.

## Development

```bash
npm ci
npm run check
npm run dev
```

Open `http://localhost:5173`. Vite proxies Socket.IO to port `3001`.

`npm ci` restores the committed dependency lockfile. `npm run check` builds the
Go executable and all three TypeScript workspaces, then runs the server and Go
tests. Run it from the repository root. The first run downloads npm packages and
the pinned Godip Go module; no provider keys, `.env`, Discord, or deployment are
needed. The tests use local stubs/mocks and do not call paid providers.

GitHub Actions runs the same commands for pull requests and pushes to `master`,
`main`, or a `codex/` branch, covering Node 22 / Go 1.23 on Linux and Node 26 /
Go 1.27 on macOS.
See [the build baseline](docs/build-baseline.md) for recorded local results and
verification limits.

LLM seats use the local stub controller unless the host selects a paid provider
such as `OPENAI` or `GEMINI`. Paid seats require the corresponding server
secret (`OPENAI_API_KEY` or `GEMINI_API_KEY`) and must pass the server-side
provider/model allowlist. Model identifiers entered per seat are treated as
requests; the server resolves them through role-specific defaults and spend
guards before making provider calls.

## Discord

Discord can provide private text and explicit-turn voice diplomacy while the
browser remains authoritative for the board, orders, and game setup. The local
integration uses one coordinator bot plus one separate bot identity for each
power.

Discord is optional. Without `DISCORD_GUILD_ID` and
`DISCORD_COORDINATOR_TOKEN`, the server starts normally with the integration
disabled. See [docs/discord-local-setup.md](docs/discord-local-setup.md) for
application creation, permissions, linking, and voice setup.

The client adjacency hints are generated from Godip's graph:

```bash
npm run generate:board
```

## Production

```bash
npm run build
npm start
```

The server listens on `PORT` (default `3001`) and serves `client/dist`.
`GET /healthz` is available for deployment health checks.

Environment variables are documented in [.env.example](.env.example).
Lightsail deployment is documented in [docs/deployment.md](docs/deployment.md).

Optional local secrets belong in the repository-root `.env`, which Git and the
Docker build context ignore. Copy your own file over SSH when needed, for example:

```bash
(umask 077 && scp 'user@desktop:~/path/to/diplomacy/.env' .env) && chmod 600 .env
```

This replaces an existing `.env`; keep a copy first if it contains local settings
you need. The build/test command does not load `.env`. Starting the server does,
so configured Discord bots may connect when you run `npm run dev` or `npm start`.

## Architecture

- `client/`: React/Vite interface and state-driven SVG board.
- `shared/`: transport contracts, game types, and board metadata.
- `server/`: rooms, authorization, sessions, controllers, and Socket.IO.
- `engine/`: isolated Go executable wrapping the Godip rules engine.

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

See [docs/architecture.md](docs/architecture.md) and
[docs/roadmap.md](docs/roadmap.md).

For the latest development checkpoint, remaining work, and setup on another
computer, see [docs/current-state.md](docs/current-state.md).

The prioritized repair checklist and verified progress are in
[docs/code-review-backlog.md](docs/code-review-backlog.md). Core browser game
correctness and recovery take priority over optional voice and Discord work.
