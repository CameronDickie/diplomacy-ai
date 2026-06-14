# Diplomacy

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

Deadlines, persistence, replay, complete engine-generated legal action menus,
additional model providers, and voice integration remain active work.

## Requirements

- Node.js 20 or newer
- npm
- Go 1.23 or newer

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies Socket.IO to port `3001`.

LLM seats use the local stub controller unless the host selects `OPENAI`.
OpenAI-backed seats require `OPENAI_API_KEY` in the server environment. Model
identifiers are entered per seat and are not hard-coded by the controller.

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

## Architecture

- `client/`: React/Vite interface and state-driven SVG board.
- `shared/`: transport contracts, game types, and board metadata.
- `server/`: rooms, authorization, sessions, controllers, and Socket.IO.
- `engine/`: isolated Go executable wrapping the Godip rules engine.

See [docs/architecture.md](docs/architecture.md) and
[docs/roadmap.md](docs/roadmap.md).
