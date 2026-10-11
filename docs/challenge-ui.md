# The challenge interface

How the challenge screens are organised and styled. Code is in
`client/src/challenge/` and `client/src/ui/ChallengeApp.tsx`. The older
hosted-room screens (`client/src/ui/App.tsx` and friends) are separate and keep
their own styling.

## One place for each kind of information

| View | Address | Holds |
| -- | -- | -- |
| Setup | `#/setup` | the challenge and its mission; the ways to play, side by side, each saying who decides the opponents, whether a model is used and whether you can message them; how it works; your past games; exhibition games; your account |
| Play | `#/play` | the map and the orders for the current turn, with the objective, the turn's status and the submit action together |
| Messages | `#/messages` | every conversation with the other powers (development playtests) |
| History | `#/history` | the orders log: every resolved phase, newest first, with each power's orders and results; any phase can be shown on the map |
| Playtest log | `#/log` | which model decided each power, timing and cost; the game record download (development playtests) |
| Operator | `#/operator` | the operator controls, for the allowlisted account |

Players are given the day's challenge. The operator, and any signed-in account
on a local development server, also get **Choose a challenge** on Setup: every
challenge in the rotation, any of which can be selected and started. The server
decides who may (`GET /api/challenges/library` is refused for anyone else, and
so is starting a challenge that is not the day's).

The view is in the address bar's hash, so Back and reload work. A view that
needs something you do not have (no game, no chat) falls back to the nearest
one that makes sense. Starting or opening a game takes you to Play.

The current turn's orders are only in Play. Past orders are only in History;
Play shows a one-line summary of last turn with a link.

A replay (the reference run, an exhibition game, or a turn from your own
history) takes over the page with the map and its controls, and returns you to
where you were.

## Style

The look follows camerondickie.ca, because the game is served from a subdomain
of it. `theme.css` carries that site's palette as CSS variables with light and
dark pairs, Source Sans 3 for text, tight Arial headings, uppercase meta labels
and thin rules instead of boxes. The header has the site's "cd" monogram, which
links home, and the same light / system / dark picker, stored under the same
`cam-theme` key and resolved before first paint in `index.html`.

- Use the role variables (`--folio-paper`, `--folio-ink`, `--folio-muted`,
  `--folio-accent`, `--folio-on-accent`, `--folio-line`, `--folio-control`,
  `--folio-success`, `--folio-warning`), not hex values. Each foreground is
  paired with a specific background; the pairs and their contrast ratios are
  documented in that site's `docs/portfolio-design.md`.
- `--folio-line` is decorative. Field and button boundaries use
  `--folio-control`.
- Everything is scoped under `.dip`, which also resets the dark control styles
  the older stylesheet applies globally.
- The map keeps its own dark frame, controls and legend in both themes.
- The primary action on a page is the arrow-fill button, adapted from
  ObsidianUI (MIT, see `THIRD_PARTY_NOTICES.md`).

## Checking a change

`npm run test:e2e` drives the journeys through these views, including a phone
width. For a visual change also look at light and dark, a phone width, keyboard
focus, and reduced motion.

## Not done

- Orders are still chosen from menus beside the map. Clicking a unit selects
  and centres it; clicking a destination does not yet give an order.
- The operator view is restyled only as far as colours.
