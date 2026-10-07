# Portable development boards

A fixture is a reviewable rules position, not a saved account or an admission
credential. The fixed JSON examples in `server/fixtures/development/` are labeled
`AI_GENERATED_DEVELOPMENT`. They are not an approved public catalog or a live-AI
difficulty claim. All witness runs use human seats and make no provider calls.

## Clean-clone commands

```sh
npm ci
npm run build
npm run fixture -- validate server/fixtures/development/tunis-expedition.v1.json
npm run fixture -- play server/fixtures/development/tunis-expedition.v1.json early-capture /tmp/tunis-after.json
npm run fixture -- validate /tmp/tunis-after.json
npm run fixture -- roundtrip /tmp/tunis-after.json /tmp/tunis-copy.json
```

Output paths must not already exist. `roundtrip` preserves a scenario envelope
when given one, or a standalone board when given a board. `play` writes the
resulting standalone board when an output path is supplied; otherwise it prints
the board, hash and score together. `validate` prints a content hash and the
available witness names. Validation reads at most 1 MiB and refuses unknown
fields/versions. These commands do not load `.env`, connect to a running server,
write a database, send emails or call a model. They need the compiled Godip
binary (`DIPLOMACY_ENGINE_PATH` may select another compatible build).

The production image also contains the fixtures and CLI:

```sh
docker run --rm --entrypoint node diplomacy:local server/dist/fixtures/cli.js validate server/fixtures/development/retreat-position.v1.json
```

There is no fixture upload HTTP/socket endpoint. The internal
`GameRoom.fromBoardFixture()` validates before constructing a new lobby; it
cannot replace an existing room's position. Future public challenge admission
must load only a server-owned, version-pinned catalog entry after admission and
budget checks. Do not expose arbitrary fixture construction to visitors.

## Version 1 board contract

`server/src/fixtures/BoardFixture.ts` defines the type and strict runtime parser.
The board contains exactly these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`; unknown versions fail closed |
| `variant`, `rulesEngine` | `CLASSICAL`, `godip@v0.6.5` |
| `powers` | All seven powers, including powers with no remaining units |
| `year`, `season`, `phase` | Integer 1–9999; SPRING/FALL with ORDERS/RETREATS, WINTER with BUILDS |
| `territoryOwners` | Every classical province exactly once, owner power or null; sea ownership is null |
| `units` | Stable id, type, power, province, coast, mustRetreat, retreatOptions, retreatCoasts, dislodgedBy |
| `retreatContext` | Null outside retreats; complete Godip `dislodgers` and `bounces` during retreats |

Supply-center locations and home powers come from the pinned classical map,
not editable fixture booleans. Their ownership is in `territoryOwners`.
Build/disband counts are derived from owned centers minus units. A fleet in
Spain, Bulgaria or St Petersburg requires the actual coast. Armies never carry
coasts. One active unit may occupy a province; a dislodged enemy may also be
present there during retreats. Unit ids must be unique.

Every unit includes explicit empty/default retreat fields when active. During
retreats, `dislodgers` maps retreat-blocking attack origins to dislodged provinces, and
`bounces` maps a destination to all recorded source provinces. A destination
list alone would lose Godip's bounce exception rules. Import reconstructs the
Godip state and requires the supplied legal retreat destinations/coasts to match
Godip exactly. Units with no legal retreat are already removed by adjudication.
These checks validate a playable rules state; they do not prove that a custom
position was reachable from the standard opening without an accompanying
witness.

Export omits players, game ids, session tokens, pending submissions, private
messages, model prompts, provider settings and presentation data. It preserves
all rule-relevant board fields, including unit ids used by retreat/disband
commands. Canonical export sorts object keys, unit ids, power order and retreat
choices. SHA-256 hashes bind the canonical board content. Builds use stable,
room-scoped year/power/province ids, with deterministic suffixes on collision,
so fixed witnesses reproduce the same exported boards.

## Scenario envelope and witnesses

A scenario adds `schemaVersion`, a slug `id`, positive `version`, `title`,
`provenance`, `board`, optional `objective`, and `witnesses`. The current optional
objective is owned supply center after settled Fall, with `humanPower`,
`territory`, `deadlineYear`, and `earlyAchievementYear`. It uses the same scorer
as the Tunis pilot. Change the scenario version when its position/objective or
witness contract changes; do not revise a version used by saved attempts.

Every witness has a unique `name`, `steps`, and `expectedOutcome` (null for an
unscored tactical fixture). Each step pins year/season/phase:

- ORDERS: `orders` lists Godip legal-order ids. Unlisted units HOLD. Illegal ids
  or two choices for a unit fail before submission.
- RETREATS: `retreats` maps unit ids to `{territory, coast}` or null. Unlisted
  retreating units disband. The room validates every choice.
- BUILDS: `adjustments` maps powers to `{builds, disbands}`. Unlisted powers
  waive available builds; mandatory disbands must be explicit.

| Fixture | Witnesses / purpose |
| --- | --- |
| `tunis-expedition.v1.json` | `early-capture`, `deadline-hold`; standard Turkish route, success/achievement and deadline failure |
| `split-coast.v1.json` | `north-coast`, `south-coast`; independent legal fleet coast choices |
| `supported-attack.v1.json` | `dislodge`; supported attack yields the imported retreat position |
| `retreat-position.v1.json` | `retreat-to-gascony`; restore and complete a retreat without replaying the prior movement |
| `winter-build.v1.json` | `build-brest`; restore an adjustment phase and build the legal home fleet |

`npm run check` plays every witness twice and compares full exported boards,
hashes and scores. It also tests invalid geography/coasts/occupancy, unknown
fields, private-field rejection, forged retreats, CLI round trips and existing
file protection. Movement and retreat legality are checked by Godip; build and
retreat application continue through the existing server phase rules. These
fixtures supplement, rather than replace, the broader Godip rules tests.

Godip deliberately omits a retreat-blocking origin for a convoyed attack. Such a
retreating unit has `dislodgedBy: null`; import still checks enemy occupancy,
complete context and every legal retreat. A null value cannot hide an origin
that is present in the context. The `allied-convoy` fixture exercises an English
landing supported from the North Sea and convoyed by a French fleet, including
export/reimport of the dislodged defender. `circular-moves` exercises a three-army
friendly rotation. Both have deterministic `cooperate` witnesses; `split-coast`
retains independent north/south witnesses. These are development regression
positions, not additional public scenarios.
