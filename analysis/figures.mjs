// Static previews of the post's figures (the site will have interactive versions of the same charts).
//   node analysis/figures.mjs -> analysis/out/fig-*.html and analysis/out/fig-*.png
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'analysis', 'out');
const stats = JSON.parse(fs.readFileSync(path.join(OUT, 'stats.json'), 'utf8'));
const loops = JSON.parse(fs.readFileSync(path.join(OUT, 'loops.json'), 'utf8'));

const NAME = { 'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-sol': 'GPT Sol 6.1', 'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5' };
const SHORT = { 'gpt-6-luna': 'Luna', 'gpt-6.1-sol': 'Sol', 'claude-haiku-5-5': 'Haiku', 'claude-sonnet-5-5': 'Sonnet' };
const OPENAI = '#2a78d6', ANTHROPIC = '#eb6834';
const color = m => m.startsWith('gpt') ? OPENAI : ANTHROPIC;
const ORDER = ['gpt-6-luna', 'gpt-6.1-sol', 'claude-haiku-5-5', 'claude-sonnet-5-5'];
const W = 880;

const page = (title, subtitle, body, note = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fcfcfb; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #0b0b0b; }
  .fig { width: ${W}px; padding: 24px 28px 20px; box-sizing: border-box; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 650; }
  .sub { font-size: 14px; color: #52514e; margin: 0 0 14px; }
  .legend { display: flex; gap: 18px; font-size: 13px; color: #52514e; margin: 0 0 8px; }
  .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .note { font-size: 12px; color: #6b6a66; margin-top: 10px; }
  svg text { font-family: inherit; }
</style></head><body><div class="fig" id="fig"><h1>${title}</h1><p class="sub">${subtitle}</p>${body}${note ? `<p class="note">${note}</p>` : ''}</div></body></html>`;
const legend = `<div class="legend"><span><i style="background:${OPENAI}"></i>OpenAI models</span><span><i style="background:${ANTHROPIC}"></i>Anthropic models</span></div>`;

// ── Figure 1: broken promises by model ─────────────────────────────────────────
function fig1() {
  const rows = ORDER.map(m => ({ m, ...stats.promiseByModel[m] }));
  const x0 = 170, x1 = W - 120, max = 25, rowH = 46;
  const sx = v => x0 + (x1 - x0) * v / max;
  let svg = `<svg width="${W - 56}" height="${rows.length * rowH + 34}">`;
  for (const t of [0, 5, 10, 15, 20, 25]) svg += `<line x1="${sx(t)}" x2="${sx(t)}" y1="0" y2="${rows.length * rowH}" stroke="#e6e5e0"/><text x="${sx(t)}" y="${rows.length * rowH + 18}" font-size="12" fill="#6b6a66" text-anchor="middle">${t}%</text>`;
  rows.forEach((r, i) => {
    const y = i * rowH + 10;
    svg += `<text x="0" y="${y + 17}" font-size="14" fill="#0b0b0b">${NAME[r.m]}</text>`;
    svg += `<rect x="${x0}" y="${y + 3}" width="${sx(r.brokenPct) - x0}" height="20" rx="4" fill="${color(r.m)}"/>`;
    svg += `<text x="${sx(r.brokenPct) + 8}" y="${y + 18}" font-size="14" font-weight="600" fill="#0b0b0b">${r.brokenPct}%<tspan dx="8" font-size="12" font-weight="400" fill="#6b6a66">of ${r.n.toLocaleString('en')} promises</tspan></text>`;
  });
  return page('How often each model broke its word', 'Share of checkable promises about its own units that a model did not keep the same turn (all 16 games).',
    legend + svg + '</svg>', 'A promise is a statement about the speaker\'s own units this turn ("A VIE holds", "I won\'t enter Belgium", "I\'ll order A KIE–DEN", "F NTH will support A PIC–BEL"), checked against the orders it gave. Conditional promises are excluded. Found by rules, not by a model; about 9 in 10 checked by hand were classified correctly.');
}

// ── Figure 2: every game, every model ──────────────────────────────────────────
function fig2() {
  const games = stats.games;
  const x0 = 250, x1 = W - 190, max = 30, rowH = 26;
  const sx = v => x0 + (x1 - x0) * v / max;
  const H = games.length * rowH + 30;
  let svg = `<svg width="${W - 56}" height="${H}">`;
  for (const t of [0, 10, 20, 30]) svg += `<line x1="${sx(t)}" x2="${sx(t)}" y1="0" y2="${games.length * rowH}" stroke="#e6e5e0"/><text x="${sx(t)}" y="${games.length * rowH + 18}" font-size="12" fill="#6b6a66" text-anchor="middle">${t}%</text>`;
  games.forEach((g, i) => {
    const y = i * rowH + 13;
    const ms = Object.keys(g.models).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    const label = ms.length === 1 ? `all ${SHORT[ms[0]]}` : ms.map(m => SHORT[m]).join(' vs ');
    svg += `<text x="0" y="${y + 4}" font-size="13" fill="#0b0b0b">Game ${g.game}</text><text x="64" y="${y + 4}" font-size="13" fill="#52514e">${label}</text>`;
    const pts = ms.map(m => g.models[m].promises.brokenPct);
    if (pts.length === 2) svg += `<line x1="${sx(Math.min(...pts))}" x2="${sx(Math.max(...pts))}" y1="${y}" y2="${y}" stroke="#c9c8c2" stroke-width="2"/>`;
    for (const m of ms) svg += `<circle cx="${sx(g.models[m].promises.brokenPct)}" cy="${y}" r="6" fill="${color(m)}" stroke="#fcfcfb" stroke-width="2"/>`;
    svg += `<text x="${x1 + 14}" y="${y + 4}" font-size="12" fill="#6b6a66">${ms.map(m => `${SHORT[m]} ${g.models[m].promises.brokenPct}%`).join(' · ')}</text>`;
  });
  return page('The gap holds in every game', 'Share of promises broken, per model, in each game. Seat swaps, rule changes, memory and more thinking time barely move it.', legend + svg + '</svg>',
    'Games 13, 14 and 16 were played at medium reasoning effort; all others at the lowest. Sol and Sonnet (games 15–16) made far fewer checkable promises (about 450 and 380) than Luna and Haiku (about 12,000 each).');
}

// ── Figure 3: temperament map ──────────────────────────────────────────────────
function fig3() {
  const pts = [];
  for (const g of stats.games) for (const [m, v] of Object.entries(g.models)) pts.push({ g: g.game, m, x: v.holdPct, y: v.promises.brokenPct });
  const L = 60, R = W - 80, T = 10, B = 330;
  const sx = v => L + (R - L) * v / 100, sy = v => B - (B - T) * v / 30;
  let svg = `<svg width="${W - 56}" height="${B + 50}">`;
  for (const t of [0, 20, 40, 60, 80, 100]) svg += `<line x1="${sx(t)}" x2="${sx(t)}" y1="${T}" y2="${B}" stroke="#eeede8"/><text x="${sx(t)}" y="${B + 18}" font-size="12" fill="#6b6a66" text-anchor="middle">${t}%</text>`;
  for (const t of [0, 10, 20, 30]) svg += `<line x1="${L}" x2="${R}" y1="${sy(t)}" y2="${sy(t)}" stroke="#eeede8"/><text x="${L - 8}" y="${sy(t) + 4}" font-size="12" fill="#6b6a66" text-anchor="end">${t}%</text>`;
  svg += `<text x="${(L + R) / 2}" y="${B + 40}" font-size="13" fill="#52514e" text-anchor="middle">Orders that were holds (standing still)</text>`;
  svg += `<text transform="translate(14 ${(T + B) / 2}) rotate(-90)" font-size="13" fill="#52514e" text-anchor="middle">Promises broken</text>`;
  for (const p of pts) svg += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="${p.m.includes('sol') || p.m.includes('sonnet') ? 8 : 6}" fill="${color(p.m)}" ${p.m.includes('sol') || p.m.includes('sonnet') ? 'fill-opacity="0.35" stroke="' + color(p.m) + '" stroke-width="2"' : 'stroke="#fcfcfb" stroke-width="2"'}/>`;
  svg += `<text x="${sx(17)}" y="${sy(27.5)}" font-size="13" fill="#0b0b0b" font-weight="600">Moves, and breaks its word</text><text x="${sx(17)}" y="${sy(25.7)}" font-size="12" fill="#52514e">Luna and Sol</text>`;
  svg += `<text x="${sx(60)}" y="${sy(14)}" font-size="13" fill="#0b0b0b" font-weight="600">Stands still, and keeps it</text><text x="${sx(60)}" y="${sy(12.2)}" font-size="12" fill="#52514e">Haiku and Sonnet</text>`;
  return page('Two temperaments', 'Each dot is one model in one game. Solid dots: the small models (Luna, Haiku). Open dots: the larger ones (Sol, Sonnet).', legend + svg + '</svg>');
}

// ── Figure 4: loops ────────────────────────────────────────────────────────────
function fig4() {
  const rep = loops.promiseRepeatTotals;
  const wary = {};
  for (const g of loops.games) for (const [m, v] of Object.entries(g.notes)) { const w = (wary[m] ??= { n: 0, k: 0 }); w.n += v.notes; w.k += v.wary; }
  const panel = (title, values, max, x) => {
    const bw = 64, gap = 22, base = 210, top = 40;
    let s = `<text x="${x}" y="16" font-size="14" font-weight="600" fill="#0b0b0b">${title}</text>`;
    ORDER.forEach((m, i) => {
      const v = values[m]; const h = (base - top) * v / max; const bx = x + i * (bw + gap);
      s += `<rect x="${bx}" y="${base - h}" width="${bw}" height="${h}" rx="4" fill="${color(m)}"/>`;
      s += `<text x="${bx + bw / 2}" y="${base - h - 8}" font-size="14" font-weight="600" text-anchor="middle" fill="#0b0b0b">${v}%</text>`;
      s += `<text x="${bx + bw / 2}" y="${base + 18}" font-size="13" text-anchor="middle" fill="#52514e">${SHORT[m]}</text>`;
    });
    return s + `<line x1="${x}" x2="${x + 4 * (bw + gap) - gap}" y1="${base}" y2="${base}" stroke="#c9c8c2"/>`;
  };
  const r = Object.fromEntries(ORDER.map(m => [m, rep[m].repeatedPct]));
  const w = Object.fromEntries(ORDER.map(m => [m, +(100 * wary[m].k / wary[m].n).toFixed(0)]));
  const svg = `<svg width="${W - 56}" height="240">${panel('Repeats a promise from last turn', r, 40, 0)}${panel('Private notes warning of betrayal', w, 100, 440)}</svg>`;
  return page('Going in circles', 'Left: share of promises that repeat, to the same power, one the model made the turn before. Right: share of its private notes (games 11–16) that warn about being betrayed.', legend + svg,
    'Haiku\'s repetition rose with memory: 21% in game 8, 29% in game 12, 33% at medium effort in game 13.');
}

// ── Figure 5: frozen boards ────────────────────────────────────────────────────
function fig5() {
  const games = loops.games;
  const x0 = 250, x1 = W - 250, rowH = 24, max = 70;
  const sx = v => x0 + (x1 - x0) * v / max;
  const who = g => { const ms = Object.keys(stats.games[g.game - 1].models).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)); return ms.length === 1 ? `all ${SHORT[ms[0]]}` : ms.map(m => SHORT[m]).join(' vs '); };
  const fill = g => { const ms = Object.keys(stats.games[g.game - 1].models); return ms.length === 1 ? color(ms[0]) : '#9a9993'; };
  let svg = `<svg width="${W - 56}" height="${games.length * rowH + 30}">`;
  for (const t of [0, 20, 40, 60]) svg += `<line x1="${sx(t)}" x2="${sx(t)}" y1="0" y2="${games.length * rowH}" stroke="#e6e5e0"/><text x="${sx(t)}" y="${games.length * rowH + 18}" font-size="12" fill="#6b6a66" text-anchor="middle">${t}%</text>`;
  games.forEach((g, i) => {
    const y = i * rowH + 4;
    svg += `<text x="0" y="${y + 13}" font-size="13">Game ${g.game}</text><text x="64" y="${y + 13}" font-size="13" fill="#52514e">${who(g)}</text>`;
    svg += `<rect x="${x0}" y="${y + 2}" width="${Math.max(2, sx(g.fallsWithoutChangePct) - x0)}" height="15" rx="4" fill="${fill(g)}"/>`;
    svg += `<text x="${sx(g.fallsWithoutChangePct) + 8}" y="${y + 14}" font-size="12" fill="#0b0b0b">${g.fallsWithoutChangePct}%${g.longestFrozenYears >= 4 ? `<tspan fill="#6b6a66">  · ${g.longestFrozenYears} years in a row</tspan>` : ''}</text>`;
  });
  return page('Frozen boards', 'Share of years in which no supply center changed hands.',
    `<div class="legend"><span><i style="background:${OPENAI}"></i>All OpenAI</span><span><i style="background:${ANTHROPIC}"></i>All Anthropic</span><span><i style="background:#9a9993"></i>Mixed</span></div>` + svg + '</svg>');
}

// ── Figure 6: the game explorer (layout mock-up) ───────────────────────────────
const VERSION = g => g <= 2 ? 'v1' : g === 3 ? 'v2' : g === 4 ? 'v3' : g === 5 ? 'v4' : g <= 9 ? 'v5' : g === 10 ? 'v6' : 'v7';
const EFFORT = g => [13, 14, 16].includes(g) ? ' · medium' : '';
const HEADLINE = {
  1: 'Austria told France its army was "for defense", then took Marseilles.',
  2: 'Italy reached 17 centers and nobody moved to stop it.',
  3: 'Seats swapped: the holding followed the model, not the country.',
  4: 'Turkey sat one center short for two years, bouncing its own units.',
  5: 'A rewritten hold rule: Haiku still held 83%.',
  6: '"Only a solo win counts": Haiku\'s holds fell to 72%.',
  7: 'A Haiku power led the board for the first time.',
  8: 'All Haiku: the board froze for decades.',
  9: 'All Luna: Turkey came back from a single center to lead.',
  10: 'One public line let three powers stop England on 17.',
  11: 'Memory. Austria\'s note: "I break my promise that SER holds."',
  12: 'Haiku used its memory as a ledger of pacts, and held more.',
  13: 'Twice the thinking; still 87% holds.',
  14: 'France promised England its centers were safe, then took London.',
  15: 'The fastest win. Sonnet barely reasoned at all.',
  16: 'Italy kept a "decoy" agreement with France going for ten years.',
};
function fig6() {
  const acts = [['Luna against Haiku', [1, 2, 3, 4, 5, 6, 7]], ['Each model against itself', [8, 9, 10, 11, 12, 13, 14]], ['The larger models', [15, 16]]];
  const card = n => {
    const g = stats.games[n - 1];
    const ms = Object.keys(g.models).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    const [season, yr] = g.reached.split(' ');
    const limit = season === 'SPRING' ? Number(yr) - 1 : Number(yr);
    const outcome = g.winner ? `${g.winner[0] + g.winner.slice(1).toLowerCase()} won, ${yr}` : g.status === 'WAITING' ? `Stopped at the cost cap, ${yr}` : `No winner by ${limit}`;
    const chips = ms.map(m => `<span class="chip" style="border-color:${color(m)}"><i style="background:${color(m)}"></i>${SHORT[m]}</span>`).join('');
    return `<div class="card"><div class="top"><b>Game ${n}</b><span class="ver">harness ${VERSION(n)}${EFFORT(n)}</span></div><div class="chips">${chips}</div><div class="out">${outcome}</div><p>${HEADLINE[n]}</p><div class="foot"><div>${ms.map(m => `${SHORT[m]} broke ${g.models[m].promises.brokenPct}% of promises`).join('<br>')}</div><div>Cost $${g.costUsd.toFixed(2)}</div></div></div>`;
  };
  const css = `<style>.act{margin:14px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#52514e}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .card{background:#fff;border:1px solid #e3e2dc;border-radius:10px;padding:10px 11px;font-size:12px}.card .top{display:flex;justify-content:space-between;align-items:baseline;gap:6px;font-size:13px;white-space:nowrap}.ver{color:#6b6a66;font-size:11px}
  .chips{margin:6px 0 4px;display:flex;gap:5px}.chip{border:1px solid;border-radius:20px;padding:1px 7px;font-size:11px}.chip i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px}
  .out{font-weight:600;margin:4px 0 2px}.card p{margin:2px 0 8px;color:#33322f;line-height:1.35;min-height:32px}.foot{display:flex;flex-direction:column;gap:3px;color:#6b6a66;font-size:11px;border-top:1px solid #efeee9;padding-top:6px}</style>`;
  const body = css + acts.map(([t, ns]) => `<div class="act">${t}</div><div class="grid">${ns.map(card).join('')}</div>`).join('');
  return page('The games, at a glance (layout mock-up)', 'On the site each card opens the game in the viewer, with a short write-up of what that game showed.', body);
}

const figs = { 'fig-1-broken': fig1(), 'fig-2-per-game': fig2(), 'fig-3-temperament': fig3(), 'fig-4-loops': fig4(), 'fig-5-frozen': fig5(), 'fig-6-explorer': fig6() };
const browser = await chromium.launch();
const pageh = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: W, height: 800 } });
for (const [name, html] of Object.entries(figs)) {
  const file = path.join(OUT, `${name}.html`);
  fs.writeFileSync(file, html);
  await pageh.goto('file://' + file);
  await (await pageh.$('#fig')).screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('wrote', name);
}
await browser.close();
