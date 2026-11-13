# Analysis

The scripts behind every number and chart in
[Do language models lie on purpose when lying is the game?](https://camerondickie.ca/writing/diplomacy).
They read the sixteen games in `../game-records/` and write JSON to `analysis/out/` (git-ignored).
None of them call a model.

Run them from the repository root, after `npm ci` and `npm run build` (the promise finder uses the
board names from `shared/`):

```bash
node analysis/promises.mjs   # every promise a power made about its own units, and whether its orders kept it
node analysis/analyze.mjs    # holds, broken promises and the per-game figures
node analysis/loops.mjs      # repetition, frozen boards, and notes that warn of betrayal
node analysis/intent.mjs     # broken promises the power's own note admits, and notes describing misleading
node analysis/admit.mjs      # the notes in which a power says it is breaking its word
```

Each prints a readable summary and writes `out/promises.json`, `out/stats.json`, `out/loops.json`,
`out/intent.json` and `out/admit.json`. Run `promises.mjs` first, since the others read its output.

The rest:

- `sample.mjs` prints a seeded random sample of promises with their verdicts, for checking by hand:
  `node analysis/sample.mjs ABSTAIN true 30 1` (kind, broken or not, how many, seed). The post's
  "about 9 in 10 classified correctly" comes from samples like this.
- `figures.mjs` draws static previews of the post's charts (`out/fig-*.html` and `.png`). It needs
  Playwright's Chromium: `npx playwright install chromium`.
- `site-data.mjs <personal-site folder>` writes the data the post's interactive charts and its
  "said vs did" explorer load. It is here to show where they come from.

## How a promise is found

`promises.mjs` is rule-based and conservative. A promise is a statement about the speaker's own units
this turn ("A VIE holds", "I won't enter Belgium", "F NTH will support A PIC–BEL"). Questions,
proposals, hedged offers ("I can", "would") and plans for later turns are not counted, and the post's
figures leave out conditional promises. Each promise is checked against the orders the speaker gave
that turn. The method notes in the post explain the rest, and the comments at the top of each script
say exactly what it counts.
