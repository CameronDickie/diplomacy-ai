import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';
import { anthropicHaikuTransport } from '../luna/HaikuTransport.js';
import { http1Fetch } from '../luna/Http1Fetch.js';
import { httpLunaTransport, mockOpponentTransport, type LunaTransport } from '../luna/Transport.js';
import { LUNA_CONTRACT, opponentContract, type OpponentContract } from '../providers/OpponentContract.js';
import { Store } from '../storage/Store.js';
import { evaluate, type EvaluationReport } from './Harness.js';

const USAGE = `Usage: evaluate --db DATABASE --run RUN_ID [--scenario tunis-expedition] [--script early-capture] [--attempts 3] [--seed 1] [--preset luna|haiku] [--out report.json]
       add --live --authorization-ref REFERENCE to call the real provider (see docs/evaluation.md)`;
/** Live runs are small on purpose: evidence first, never spending to use up a balance. */
export const LIVE_ATTEMPT_LIMIT = 10;

/**
 * Decides whether a live run may begin. Every condition is something only the owner can arrange:
 * the flag, a provider key in the environment, an existing database, and a funding grant recorded
 * in that database under the reference given here. The ledger then bounds what the run can spend.
 */
/** The one environment variable each preset's key is read from. A key for one provider is never offered to the other. */
export const keyVariable = (contract: OpponentContract): 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' => contract.preset.provider === 'ANTHROPIC' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
export function liveTransport(input: { live: boolean; db: string; authorizationRef?: string; attempts: number; apiKey?: string; fetchImpl?: typeof fetch; contract?: OpponentContract }): LunaTransport | null {
  if (!input.live) return null;
  if (!input.authorizationRef) throw new Error('A live run needs --authorization-ref naming the funding grant that authorizes it.');
  const contract = input.contract ?? LUNA_CONTRACT;
  if (!input.apiKey) throw new Error(`A live run needs the provider key in the environment (${keyVariable(contract)}). It is never read from a file or an argument.`);
  if (input.attempts > LIVE_ATTEMPT_LIMIT) throw new Error(`A live run is limited to ${LIVE_ATTEMPT_LIMIT} attempts.`);
  if (!existsSync(input.db)) throw new Error('A live run needs the existing ledger database. A new database would hide earlier spend.');
  const db = new DatabaseSync(input.db,{ readOnly: true });
  try {
    const grant = db.prepare('SELECT amount_nanousd FROM funding_grants WHERE authorization_ref=?').get(input.authorizationRef);
    if (!grant) throw new Error('No funding grant with that authorization reference is recorded in this database.');
  } finally { db.close(); }
  // The tools' long runs use plain HTTP/1.1 requests (see http1Fetch); the server keeps the built-in fetch.
  const fetchImpl = input.fetchImpl ?? http1Fetch;
  return contract.key === 'haiku' ? anthropicHaikuTransport(input.apiKey,fetchImpl) : httpLunaTransport(input.apiKey,fetchImpl);
}
export function format(report: EvaluationReport): string {
  const s = report.summary, lines = [
    `Run ${report.manifest.runId} · ${report.manifest.transport.toUpperCase()} transport · ${report.manifest.scenario} v${report.manifest.scenarioVersion} · script ${report.manifest.script}`,
    `Preset ${report.manifest.presetId} (${report.manifest.model}, prices ${report.manifest.pricingVersion}) · context ${report.manifest.contextVersion}`,
    `Status ${report.status} · Attempts ${s.attempts}: ${s.successes} succeeded, ${s.failures} failed, ${s.stalled} stalled · ${s.phases} phases · ${s.calls} calls, ${s.validCalls} valid`,
    `Timing evidence: ${s.timedPhases}/${s.phases} committed phases timed · ${s.timingIssues} issue(s)`,
    `Tokens ${s.inputTokens} in (${s.cachedInputTokens} cached) / ${s.outputTokens} out`,
    `Cost: settled USD ${(s.settledNanousd / 1e9).toFixed(6)} · still held USD ${(s.heldNanousd / 1e9).toFixed(6)} · worst-case reserved USD ${(s.reservedEstimateNanousd / 1e9).toFixed(6)}`,
    `Ledger ${report.ledger.reconciles ? 'reconciles' : 'DOES NOT RECONCILE'}: settled moved by USD ${((report.ledger.settledAfterNanousd - report.ledger.settledBeforeNanousd) / 1e9).toFixed(6)}`,
    '', 'Target check:',
    ...report.targets.map(t => `  ${t.met === null ? 'n/a ' : t.met ? 'met ' : 'MISS'}  ${t.name}: ${t.measured} (target ${t.target})`),
    ...(report.notes.length ? ['', ...report.notes.map(n => `Note: ${n}`)] : []),
  ];
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { db: { type: 'string' }, run: { type: 'string' }, scenario: { type: 'string', default: 'tunis-expedition' }, script: { type: 'string', default: 'early-capture' },
    attempts: { type: 'string', default: '3' }, seed: { type: 'string', default: '1' }, out: { type: 'string' }, live: { type: 'boolean', default: false }, preset: { type: 'string', default: 'luna' }, 'authorization-ref': { type: 'string' } }, strict: true });
  if (!values.db || !values.run) throw new Error(USAGE);
  const attempts = Number(values.attempts), seed = Number(values.seed), db = resolve(values.db);
  if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(seed)) throw new Error(USAGE);
  if (values.out && existsSync(values.out)) throw new Error('Refusing to overwrite an existing report file.');
  const contract = opponentContract(values.preset);
  const live = liveTransport({ live: values.live, db, authorizationRef: values['authorization-ref'], attempts, apiKey: process.env[keyVariable(contract)], contract });
  const store = await Store.open(db);
  try {
    const report = await evaluate({ store, runId: values.run, scenario: values.scenario, script: values.script, attempts, seed,
      contract, transport: live ?? mockOpponentTransport(contract,{ pick: 'seeded', seed }), transportKind: live ? 'live' : 'mock', log: line => console.log(line) });
    console.log(`\n${format(report)}`);
    if (values.out) await writeFile(values.out,`${JSON.stringify(report,null,2)}\n`,{ flag: 'wx', mode: 0o600 });
    if (!report.ledger.reconciles) process.exitCode = 2;
    else if (report.status === 'INTERRUPTED') process.exitCode = 1;
  } finally { await store.close(); await shutdownGodip(); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Evaluation failed.'); process.exitCode = 1; });
}
