// Prints a seeded random sample of commitments with their verdicts, for checking by hand.
//   node analysis/sample.mjs KIND BROKEN(true|false|any) N [seed] [model]
import fs from 'node:fs';
const [kind = 'ABSTAIN', brokenArg = 'any', nArg = '10', seedArg = '1', model = ''] = process.argv.slice(2);
const { commitments } = JSON.parse(fs.readFileSync(new URL('./out/promises.json', import.meta.url)));
let seed = Number(seedArg);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pool = commitments.filter(c => (kind === 'ANY' || c.kind === kind) && (brokenArg === 'any' || String(c.broken) === brokenArg) && (!model || c.model.includes(model)));
const picked = [];
while (picked.length < Math.min(Number(nArg), pool.length)) { const c = pool[Math.floor(rand() * pool.length)]; if (!picked.includes(c)) picked.push(c); }
for (const [i, c] of picked.entries()) {
  console.log(`#${i + 1} g${c.game} ${c.season} ${c.year} ${c.speaker}(${c.model})->${c.recipient} ${c.kind}${c.conditional ? ' [cond]' : ''} units=${c.units ?? 'ALL'} targets=${c.targets}${c.supported ? ' supported=' + c.supported : ''} => ${c.broken ? 'BROKEN' : 'kept'} ${c.evidence.join(', ')}`);
  console.log(`   "${c.text}"`);
}
