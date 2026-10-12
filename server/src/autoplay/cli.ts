import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ALL_POWERS, type Power } from '@diplomacy/shared';
import { shutdownGodip } from '../adjudication/GodipAdjudicator.js';
import { keyVariable, liveTransport } from '../evaluation/cli.js';
import { mockOpponentTransport, type LunaTransport } from '../luna/Transport.js';
import { OPPONENT_CONTRACTS, opponentContract } from '../providers/OpponentContract.js';
import { Store } from '../storage/Store.js';
import { DEFAULT_ASSIGNMENT, LATEST_LAST_YEAR, autoplay, type AutoplayResult, type ModelKey } from './Autoplay.js';

const USAGE = `Usage: autoplay --db DATABASE --run RUN_ID [--until 1908|win] [--models AUSTRIA=luna,ENGLAND=haiku,...] [--messages 3] [--message-retries 2] [--order-calls 6] [--max-phases N] [--attempt-cap USD] [--resume-paid] [--seed 1] [--out FILE]
       Plays one full game with a model on every power. Free stand-in models unless --live is given.
       add --live --authorization-ref REFERENCE to call the real providers (see docs/autoplay.md)`;

/** "AUSTRIA=luna,ENGLAND=haiku": powers not named keep the default split. */
export function parseAssignment(text: string | undefined): Record<Power, ModelKey> {
  const assignment = { ...DEFAULT_ASSIGNMENT };
  for (const part of (text ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [power, key, extra] = part.split('=').map(s => s.trim());
    if (extra !== undefined || !ALL_POWERS.includes(power?.toUpperCase() as Power) || !Object.hasOwn(OPPONENT_CONTRACTS,key?.toLowerCase() ?? '')) throw new Error(`Cannot read "${part}". Write POWER=luna or POWER=haiku.`);
    assignment[power.toUpperCase() as Power] = key.toLowerCase() as ModelKey;
  }
  return assignment;
}
/**
 * Development only. The same default as the server's configuration: `local` unless this is a
 * production build, and anything other than `local` is refused.
 */
export function assertDevelopment(env: NodeJS.ProcessEnv): void {
  if ((env.DIPLOMACY_PROFILE ?? (env.NODE_ENV === 'production' ? 'showcase' : 'local')) !== 'local')
    throw new Error('Autoplay is a development tool. It runs only with DIPLOMACY_PROFILE=local.');
}
export function format(result: AutoplayResult): string {
  const s = result.summary, usd = (n: number) => `USD ${(n / 1e9).toFixed(4)}`;
  return [
    `Run ${result.run.runId} · ${result.run.transport.toUpperCase()} transport · ${result.run.lastYear === LATEST_LAST_YEAR ? 'until a power wins' : `to Fall ${result.run.lastYear}`} · messages to up to ${result.run.talkRecipients} powers`,
    `Models: ${ALL_POWERS.map(p => `${p} ${result.run.assignment[p]}`).join(', ')}`,
    `Status ${result.status}${result.endedBy === 'SOLO_WIN' ? ' · ended by a solo win' : result.endedBy === 'LAST_YEAR' ? ` · ended after Fall ${result.run.lastYear}` : ''}${result.waitingOn ? ` · ${result.waitingOn}` : ''}`,
    ...(result.record.failures.length ? [`Failures recorded: ${result.record.failures.length} (listed under record.failures)`] : []),
    `Reached ${s.season} ${s.year} after ${s.phases} phases${s.winner ? ` · ${s.winner} won` : ''}`,
    `Supply centers: ${ALL_POWERS.map(p => `${p} ${s.centers[p]}`).join(', ')}`,
    `Order calls ${s.calls} (${s.validCalls} valid) · message calls ${s.talkCalls} · messages sent ${s.messages}`,
    `Largest request, in input tokens: orders ${s.peakInputTokens.orders}, messages ${s.peakInputTokens.ask}, replies ${s.peakInputTokens.reply}`,
    `Cost: settled ${usd(s.settledNanousd)} · still held ${usd(s.heldNanousd)}`,
    ...(result.run.transport === 'mock' ? ['Note: stand-in models. Tokens, timing and cost say nothing about the real ones; only the plumbing is exercised.'] : []),
  ].join('\n');
}

async function main() {
  assertDevelopment(process.env);
  const { values } = parseArgs({ options: { db: { type: 'string' }, run: { type: 'string' }, until: { type: 'string', default: '1908' }, models: { type: 'string' }, messages: { type: 'string', default: '3' }, 'message-retries': { type: 'string', default: '2' }, 'order-calls': { type: 'string', default: '6' },
    'max-phases': { type: 'string' }, 'attempt-cap': { type: 'string' }, seed: { type: 'string', default: '1' }, out: { type: 'string' }, live: { type: 'boolean', default: false }, 'resume-paid': { type: 'boolean', default: false }, 'authorization-ref': { type: 'string' } }, strict: true });
  if (!values.db || !values.run) throw new Error(USAGE);
  const db = resolve(values.db), lastYear = values.until === 'win' ? LATEST_LAST_YEAR : Number(values.until), talkRecipients = Number(values.messages), messageRetries = Number(values['message-retries']), orderCalls = Number(values['order-calls']), seed = Number(values.seed);
  const maxPhases = values['max-phases'] === undefined ? undefined : Number(values['max-phases']);
  if (![lastYear,talkRecipients,messageRetries,orderCalls,seed].every(Number.isSafeInteger) || (maxPhases !== undefined && (!Number.isSafeInteger(maxPhases) || maxPhases < 1))) throw new Error(USAGE);
  const assignment = parseAssignment(values.models), keys = [...new Set(Object.values(assignment))];
  const transports: Partial<Record<ModelKey, LunaTransport>> = {};
  for (const key of keys) {
    const contract = opponentContract(key);
    // Each transport is given only its own provider's key, read from the environment.
    transports[key] = liveTransport({ live: values.live, db, authorizationRef: values['authorization-ref'], attempts: 1, apiKey: process.env[keyVariable(contract)], contract })
      ?? mockOpponentTransport(contract,{ pick: 'seeded', seed });
  }
  const out = resolve(values.out ?? `autoplay-${values.run}.json`);
  const store = await Store.open(db), stop = new AbortController();
  // Ctrl-C finishes the phase in hand and writes the record; the game can then be continued.
  process.once('SIGINT',() => { console.log('\nStopping after this phase…'); stop.abort(); });
  try {
    if (values['attempt-cap'] !== undefined) {
      const cap = Math.round(Number(values['attempt-cap']) * 1e9), totals = await store.call('fundingTotals',{});
      if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('--attempt-cap is an amount in USD, for example 5.');
      // Keeps whatever overall limit is already in force; only the per-game cap changes.
      await store.call('setFundingPolicy',{ attemptCapNanousd: cap, ceilingLimitNanousd: totals.ceilingNanousd < totals.grantedNanousd ? totals.ceilingNanousd : null, now: Date.now() });
    }
    // A pause is written when a grant runs out. Lifting it is the owner's call, made by passing this flag.
    if (values['resume-paid']) await store.call('setPaidStopped',{ stopped: false, operatorId: 'autoplay-cli', now: Date.now() });
    const funds = await store.call('fundingTotals',{});
    console.log(`Funding: USD ${(funds.availableNanousd / 1e9).toFixed(4)} available · this game may spend up to USD ${(funds.attemptCapNanousd / 1e9).toFixed(2)}${values.live ? '' : ' (stand-in models: only numbers)'}`);
    const result = await autoplay({ store, runId: values.run, lastYear, assignment, transports, transportKind: values.live ? 'live' : 'mock', talkRecipients, messageRetries, orderCalls, maxPhases, signal: stop.signal, log: line => console.log(line) });
    console.log(`\n${format(result)}`);
    // The record holds no keys and no prompts; it is still private game data, so only its owner may read it.
    await writeFile(out,`${JSON.stringify(result,null,2)}\n`,{ mode: 0o600 });
    console.log(`Game record: ${out}`);
    if (result.status !== 'FINISHED') process.exitCode = 1;
  } finally { await store.close(); await shutdownGodip(); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Autoplay failed.'); process.exitCode = 1; });
}
