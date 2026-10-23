# The game interface

How the screens are organised and styled. There are two ways to play, in one
shared frame (`client/src/challenge/Shell.tsx`):

| Page | Address | What it is | Code |
| -- | -- | -- | -- |
| Daily challenge | `/challenge` | one scenario with an objective and a deadline, played alone | `client/src/challenge/`, `client/src/ui/ChallengeApp.tsx` |
| Hosted games | `/` | a full seven-power game that people create, share by code and play to its end | `client/src/rooms/` |

The header has a switch between the two. Hosted games do not exist in the
showcase profile (production), so there `/` is the challenge and the switch is
not shown. Both pages use the same map component (`client/src/ui/MapGraph.tsx`),
so trackpad panning, pinch zoom and centring on the selected unit behave the
same in both.

## Daily challenge

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

On the map, click one of your units and then a highlighted place to order the
move (by convoy only when nothing else reaches it); click the unit again to let
it go. Supports and convoys are chosen in the menus.

The current turn's orders are only in Play. Past orders are only in History;
Play shows a one-line summary of last turn with a link.

A replay (the reference run, an exhibition game, or a turn from your own
history) takes over the page with the map and its controls, and returns you to
where you were.

### Wording a player sees

Places are always named, never coded. A unit's order menu sits under the unit
("Army · Paris"), so its choices do not repeat it: "Hold", "Move to Burgundy",
"Move to Norway by convoy", "Support Marseilles into Burgundy". A support or
convoy for another power's unit names its owner, "Support Munich (Germany) into
Burgundy", so it is never mistaken for one of your own. Retreats read "Retreat
to Spain (north coast)" and fleet builds "Fleet · north coast". The text comes
from `describeChoice` in `client/src/challenge/text.ts`; the server's own
order descriptions, which the models read, are unchanged.

An error is shown at the top of the page and is brought into view and focused
when it appears, wherever the action that caused it was (`useReveal` in
`Shell.tsx`).

## Hosted games

| View | Address | Holds |
| -- | -- | -- |
| Game | `#/game` | creating or joining a game; then the game code, who sits where, how empty seats are filled, the host's settings and the start; once running, each power's player, supply centers, status and voice controls; Discord linking |
| Play | `#/play` | the map and your orders for the current turn, and which powers the turn is waiting on |
| Messages | `#/messages` | one private thread per power |
| History | `#/history` | the orders log, the animated replay of any phase, and the public game export |
| Event log | `#/log` | what this browser sent and received (host only) |

Orders can be given two ways that feed one list: click a unit on the map and
then a province (a small menu offers hold, move, coast or convoy), or select
the unit in the list and use the menus, which also cover supports and convoys.
Starting the game takes every player to Play.

What the host is offered for empty seats depends on who they are: the operator
can add model opponents; on a local server anyone can add offline bots, which
always hold; otherwise seats are filled by people joining.

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

- The operator view is restyled only as far as colours.
