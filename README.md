# Diplomacy

A browser-based implementation of standard Diplomacy for private games, with a
server architecture designed to support human and LLM-controlled powers.

## Current MVP

- Create a game, share its code, and fill any empty powers with stub controllers.
- Resume a human seat after a browser or network reconnect.
- Render and click the actual province geometry instead of an adjacency diagram.
- Select a unit and click an adjacent province to prepare a move order.
- Enter holds, moves, supports, convoys, retreats, builds, and disbands.
- Preserve split-coast movement, retreat, and build choices.
- Adjudicate movement and convoy rules with the pinned Godip engine.
- Run the built client and Socket.IO server from one Node process.

Negotiation, deadlines, persistence, replay, map pan/zoom, and real LLM provider
calls remain active work.

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
