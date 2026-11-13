// Data for the post on the personal site (camerondickie.ca/writing/diplomacy).
//   node analysis/site-data.mjs ~/projects/personal-site
// Writes client/src/writing/diplomacy/data.json (the figures and game cards) and
// client/public/writing/diplomacy/promises/game-N.json (the said-vs-did explorer, loaded on demand).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'analysis', 'out');
const site = process.argv[2];
if (!site) throw new Error('usage: node analysis/site-data.mjs <personal-site folder>');

const read = name => JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'));
const stats = read('stats.json');
const loops = read('loops.json');
const { commitments } = read('promises.json');

const POWERS = ['AUSTRIA', 'ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'];
const MODEL = { 'gpt-6-luna': 'luna', 'claude-haiku-5-5': 'haiku', 'gpt-6.1-sol': 'sol', 'claude-sonnet-5-5': 'sonnet' };
const KINDS = ['HOLD', 'ABSTAIN', 'MOVE', 'SUPPORT'];
const VERSION = g => g <= 2 ? 1 : g === 3 ? 2 : g === 4 ? 3 : g === 5 ? 4 : g <= 9 ? 5 : g === 10 ? 6 : 7;
const MEDIUM = new Set([13, 14, 16]);

/** The viewer's turn index (phases with a report) for each "YEAR:SEASON:TYPE". */
function turnIndex(runId) {
  const game = JSON.parse(fs.readFileSync(path.join(ROOT, 'game-records', `${runId}.json`), 'utf8'));
  const turns = game.record.phases.filter(p => p.report);
  const byKey = new Map(turns.map((p, i) => [p.phaseId.split(':').slice(1).join(':'), i]));
  return { game, turns, byKey };
}

// Moments the post links to, opened in the viewer at that turn.
const MOMENTS = [
  [4, '1971:FALL:ORDERS'], [10, '1947:FALL:ORDERS'], [11, '1921:SPRING:ORDERS'], [11, '1941:FALL:ORDERS'],
  [14, '1906:FALL:ORDERS'], [16, '1909:FALL:ORDERS'], [16, '1911:FALL:ORDERS'], [2, '1934:FALL:ORDERS'],
];

const wary = {};
for (const g of loops.games) for (const [m, v] of Object.entries(g.notes)) {
  const w = (wary[MODEL[m]] ??= { notes: 0, wary: 0 }); w.notes += v.notes; w.wary += v.wary;
}

const models = Object.fromEntries(Object.entries(stats.promiseByModel).map(([m, v]) => [MODEL[m], {
  promises: v.n, broken: v.broken, brokenPct: v.brokenPct, againstRecipient: v.againstRecipient,
  repeatedPct: loops.promiseRepeatTotals[m].repeatedPct,
  waryPct: wary[MODEL[m]] ? Math.round(100 * wary[MODEL[m]].wary / wary[MODEL[m]].notes) : null,
}]));

const moments = {};
const games = stats.games.map(g => {
  const l = loops.games.find(x => x.game === g.game);
  const { byKey, turns } = turnIndex(g.runId);
  for (const [n, key] of MOMENTS) if (n === g.game) {
    if (!byKey.has(key)) throw new Error(`game ${n}: no turn ${key}`);
    moments[`${n}:${key}`] = byKey.get(key);
  }
  const [season, year] = g.reached.split(' ');
  return {
    game: g.game, runId: g.runId, version: VERSION(g.game), medium: MEDIUM.has(g.game),
    winner: g.winner ?? null, stopped: g.status === 'WAITING', reached: { season, year: Number(year) },
    costUsd: g.costUsd, turns: turns.length,
    frozenPct: l.fallsWithoutChangePct, longestFrozenYears: l.longestFrozenYears,
    models: Object.fromEntries(Object.entries(g.models).map(([m, v]) => [MODEL[m], {
      holdPct: v.holdPct, promises: v.promises.n, brokenPct: v.promises.brokenPct,
      repeatedPct: l.promiseRepeats[m]?.repeatedPct ?? null,
    }])),
    assignment: Object.fromEntries(Object.entries(g.assignment).map(([p, m]) => [p, MODEL[m]])),
  };
});

const dataFile = path.join(site, 'client/src/writing/diplomacy/data.json');
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
fs.writeFileSync(dataFile, JSON.stringify({ models, games, moments }, null, 1) + '\n');

// Per game: each unconditional promise, by viewer turn, with the speaker's private note that turn (games 11+).
const promiseDir = path.join(site, 'client/public/writing/diplomacy/promises');
fs.rmSync(promiseDir, { recursive: true, force: true });
fs.mkdirSync(promiseDir, { recursive: true });
let total = 0;
for (const g of games) {
  const { game, byKey } = turnIndex(g.runId);
  const turns = game.record.phases.filter(p => p.report);
  const rows = [];
  const notes = {};
  for (const c of commitments) {
    if (c.game !== g.game || c.conditional) continue;
    const turn = byKey.get(`${c.year}:${c.season}:ORDERS`);
    if (turn === undefined) throw new Error(`game ${g.game}: no orders turn for ${c.year} ${c.season}`);
    rows.push([turn, POWERS.indexOf(c.speaker), POWERS.indexOf(c.recipient), KINDS.indexOf(c.kind), c.text, c.broken ? 1 : 0, c.evidence ?? [], c.againstRecipient ? 1 : 0]);
    const note = turns[turn].notes?.find(n => n.power === c.speaker)?.note;
    if (note) notes[`${turn}:${POWERS.indexOf(c.speaker)}`] = note;
  }
  total += rows.length;
  const label = i => { const [year, season] = turns[i].phaseId.split(':').slice(1); return `${season[0]}${season.slice(1).toLowerCase()} ${year}`; };
  const turnNames = Object.fromEntries([...new Set(rows.map(r => r[0]))].map(i => [i, label(i)]));
  fs.writeFileSync(path.join(promiseDir, `game-${g.game}.json`), JSON.stringify({ game: g.game, turns: turnNames, rows, notes }) + '\n');
}
console.log(`data.json: ${games.length} games, ${Object.keys(moments).length} moments; ${total} promises in ${games.length} files`);
