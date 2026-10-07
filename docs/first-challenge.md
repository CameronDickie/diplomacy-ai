# First challenge pilot: Tunis expedition

This is an authored **scenario pilot**, not a full-rule Diplomacy victory or a
daily challenge yet. Its versioned definition and authoritative scorer live in
`server/src/challenge/TunisPilot.ts`. Keep version 1 unchanged once attempts are
persisted; change the version when the board, objective, deadline, or scoring
rules change, and store the id and version with every attempt.

## Starting position and objective

- Classical standard 1901 Spring opening, using Godip v0.6.5. Turkey is the
  human power; Austria, England, France, Germany, Italy, and Russia are the six
  opponent powers. The sponsored pilot intends to use server-owned Luna seats;
  the offline fixture substitutes human HOLD orders and makes no provider calls.
- **Own Tunis after Fall 1903 is fully resolved** to succeed. Ownership is
  checked from the server's settled Fall phase report, after retreats when
  required. Entering Tunis in Spring does not count. Fall 1903 is included in
  the three-year window; Fall 1904 is too late.
- Owning Tunis after Fall 1902 or earlier grants the `EARLY_CAPTURE`
  achievement. The objective is personal and unranked because Luna opponents
  can make different decisions on different attempts. There is no leaderboard.
- Success ends scoring at the first qualifying settled Fall. If the deadline
  resolves without Turkish ownership, the attempt fails. A normal game ending
  before success also fails. Abandonment before success yields `ABANDONED` and
  no achievement. A still-active attempt awaiting a settled Fall is
  `INCOMPLETE`. One supply center has one owner, so ties are not possible.

The public challenge flow will need to show the objective, remaining years,
the settled result, and any achievement. DIC-54 owns that UI and setup flow;
DIC-59 owns durable attempt reports. The source of truth for scoring is the
server-recorded phase history, not a model's explanation or browser state.

## Offline reachability and failure fixtures

`server/fixtures/development/tunis-expedition.v1.json` contains the portable
starting board, objective and named success/deadline witnesses. The pilot
definition pins that fixture id/version. `server/src/test/TunisPilot.test.ts`
loads its board with seven human seats and lets Godip adjudicate every movement
phase. Its successful route is:

1. Spring 1901: A Smyrna → Armenia, A Constantinople → Smyrna, F Ankara →
   Constantinople. The coordinated opening clears the fleet's path.
2. Fall 1901: F Constantinople → Aegean Sea.
3. Spring 1902: F Aegean Sea → Ionian Sea.
4. Fall 1902: F Ionian Sea → Tunis. Settled Fall ownership becomes Turkey's,
   giving success and the early achievement.

All other units HOLD in this witness. The failure fixture holds every unit
through Fall 1903 and checks the deadline result. A separate fixture confirms
that reaching Tunis in Spring 1903 is incomplete until Fall, while holding it
after Fall 1903 still succeeds without the early achievement. Another fixture
checks that Fall orders with pending retreats are not scored until retreat
ownership is settled. Run `npm run check` from a clean clone to execute these without
credentials or a clock. These fixtures prove reachability and deterministic
scoring; they do **not** prove that live Luna play has a fair difficulty or
acceptable cost. DIC-68 measures that before release.

## Catalog and rotation policy

Ship this as one named development pilot. AI-generated, fixed and versioned
scenarios are authorized for development and testing. The owner will curate the
public catalog before release; no minimum catalog size has been approved. Use
the daily label only after an approved catalog and rotation have passed offline
reachability/failure fixtures and live quality checks. A future daily schedule
should pin a challenge id and version for each date, publish the schedule before
attempts start, and preserve prior definitions for replay. Do not generate or
silently revise the official scenario during a day. See [portable JSON
fixtures](board-fixtures.md) for local commands to validate, play and export
these fixed development scenarios.

## Development rotation (implemented)

`server/fixtures/rotation/development.v1.json` lists pinned scenario
id/version pairs and an `epochDay`. `featuredSlot` in
`server/src/challenge/Catalog.ts` is a pure function of that manifest and the
clock: `(UTC day number − epoch day number) mod entries`, wrapping backwards for
earlier dates. The same instant therefore features the same scenario version on
every server and after every restart, and the change happens exactly at
00:00:00.000 UTC, the same boundary as the per-account daily start allowance.

| Slot | Scenario | Power | Target | Deadline / early |
| -- | -- | -- | -- | -- |
| 0 | `tunis-expedition` v1 | Turkey | Tunis | Fall 1903 / 1902 |
| 1 | `belgian-landing` v1 | England | Belgium | Fall 1902 / 1901 |
| 2 | `iberian-march` v1 | France | Portugal | Fall 1902 / 1901 |
| 3 | `adriatic-descent` v1 | Austria | Greece | Fall 1902 / 1901 |
| 4 | `danish-straits` v1 | Germany | Denmark | Fall 1902 / 1901 |
| 5 | `sicilian-crossing` v1 | Italy | Tunis | Fall 1902 / 1901 |

Behaviour:

- `GET /api/challenges` returns only the featured card plus a `rotation` block
  (`day`, `index`, `size`, `nextChangeAt`, label `DEVELOPMENT_ROTATION`).
  `GET /api/challenges/demo` serves that scenario's `early-capture` witness.
- Only the featured scenario can be started. A start naming another catalog
  entry is refused with `409` ("the featured challenge has changed"), except
  that a retry of an already accepted start still returns its attempt.
- An attempt stores its challenge id and version, so one begun before midnight
  keeps its board, objective, deadline and scorer afterwards and across restart.
- Every scenario is registered at startup under its content hash; editing a
  shipped fixture is rejected, so a change needs a new version and a new
  manifest version.

These five extra scenarios are AI-generated development fixtures that reuse the
standard 1901 opening with a different power and target. Against hold-only
practice opponents each is winnable in one game year; they exist to exercise
rotation, pinning and scoring, not as balanced content. Their success and
deadline witnesses run in `BoardFixture.test.ts` and `Rotation.test.ts`.

**This is not the public daily schedule.** The UI labels it "Development
rotation" and never "daily". Publishing a daily label still needs the owner's
approved catalog (replace the manifest and fixtures with a new version), live
quality evidence from DIC-68 and the DIC-72 release gate.
