import type { GameRecord, PlaytestLog, PlaytestPhase, PlaytestTalkCall, PublicPhaseReport } from '@diplomacy/shared';
import type { StoredAttempt, StoredChallenge } from '../storage/contracts.js';
import { coherenceIssues } from '../luna/Choices.js';
import type { Store } from '../storage/Store.js';

/**
 * Per phase and power: which model was asked, what it chose, how long the provider took and what the
 * call cost. Built from the accounting records only; prompts and raw answers are never stored.
 */
export async function playtestLog(store: Store, attemptId: string): Promise<PlaytestLog> {
  const calls = (await store.call('providerCallsForAttempt',{ attemptId })).sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const phases: PlaytestPhase[] = [], byOperation = new Map<string, PlaytestPhase>();
  const models: PlaytestLog['models'] = {};
  const blank = () => ({ calls: 0, valid: 0, costNanousd: 0, heldNanousd: 0, latencyMsTotal: 0, timedCalls: 0, outputTokens: 0, incoherent: 0, chatCalls: 0, chatCostNanousd: 0, talkCalls: 0, talkValid: 0, talkCostNanousd: 0 });
  const said = new Map((await store.call('powerTalks',{ attemptId })).map(t => [t.callId,t.messages]));
  for (const call of calls) {
    if (call.role === 'CHAT') {
      // A reply to the player, not a decision: counted and costed on its own so the two can be compared.
      const total = models[call.model] ??= blank();
      total.chatCalls++; total.chatCostNanousd += call.usage?.costNanousd ?? 0;
      if (!call.usage && call.dispatchedAt !== null) total.heldNanousd += call.maxCostNanousd;
      continue;
    }
    let phase = byOperation.get(call.fence.operationId)!;
    if (!phase) {
      const decisions = new Map((await store.call('providerDecisions',{ operationId: call.fence.operationId })).map(d => [d.callId,d.action]));
      phase = { phaseId: call.fence.phaseId, kind: call.role === 'ASK' || call.role === 'REPLY' ? 'ORDERS' : call.role, calls: [] };
      byOperation.set(call.fence.operationId,phase); phases.push(phase);
      (phase as PlaytestPhase & { decisions?: typeof decisions }).decisions = decisions;
    }
    const latency = call.dispatchedAt !== null && call.receivedAt !== null ? call.receivedAt - call.dispatchedAt : null;
    if (call.role === 'ASK' || call.role === 'REPLY') {
      // Messages to other powers, not a decision: listed and costed apart so the two can be compared.
      const total = models[call.model] ??= blank(), entry: PlaytestTalkCall = { power: call.power, model: call.model, round: call.role, outcome: call.outcome, latencyMs: latency,
        inputTokens: call.usage?.inputTokens ?? null, outputTokens: call.usage?.outputTokens ?? null, reasoningTokens: call.usage?.reasoningTokens ?? null,
        costNanousd: call.usage?.costNanousd ?? null, heldNanousd: call.usage ? 0 : call.dispatchedAt !== null ? call.maxCostNanousd : 0, messages: said.get(call.id) ?? [] };
      (phase.talk ??= []).push(entry);
      total.talkCalls++; if (call.outcome === 'VALID') total.talkValid++; total.talkCostNanousd += call.usage?.costNanousd ?? 0;
      if (!call.usage && call.dispatchedAt !== null) total.heldNanousd += call.maxCostNanousd;
      continue;
    }
    const decisions = (phase as PlaytestPhase & { decisions?: Map<string, unknown> }).decisions!;
    const action = decisions.get(call.id) as { orderIds?: string[]; retreats?: unknown; builds?: unknown } | undefined;
    const latencyMs = call.dispatchedAt !== null && call.receivedAt !== null ? call.receivedAt - call.dispatchedAt : null;
    phase.calls.push({ power: call.power, model: call.model, outcome: call.outcome, latencyMs,
      inputTokens: call.usage?.inputTokens ?? null, outputTokens: call.usage?.outputTokens ?? null, reasoningTokens: call.usage?.reasoningTokens ?? null,
      costNanousd: call.usage?.costNanousd ?? null, heldNanousd: call.usage ? 0 : call.dispatchedAt !== null ? call.maxCostNanousd : 0,
      decision: action ?? null, issues: Array.isArray(action?.orderIds) ? coherenceIssues(action.orderIds) : [] });
    if (Array.isArray(action?.orderIds) && coherenceIssues(action.orderIds).length) (models[call.model] ??= blank()).incoherent++;
    const total = models[call.model] ??= blank();
    total.calls++; if (call.outcome === 'VALID') total.valid++;
    total.costNanousd += call.usage?.costNanousd ?? 0; total.outputTokens += call.usage?.outputTokens ?? 0;
    if (!call.usage && call.dispatchedAt !== null) total.heldNanousd += call.maxCostNanousd;
    if (latencyMs !== null) { total.latencyMsTotal += latencyMs; total.timedCalls++; }
  }
  for (const phase of phases) delete (phase as PlaytestPhase & { decisions?: unknown }).decisions;
  return { attemptId, phases, models };
}

/**
 * Everything recorded about one attempt: each phase's public report, every opponent call with its
 * model, decision, timing, tokens and cost, the player's conversations, and why any phase waited.
 * Prompts and model reasoning are not in it because they are never stored.
 */
export async function gameRecord(store: Store, attempt: StoredAttempt, challenge: StoredChallenge, opponents: Record<string, string>,
    failures: ReadonlyArray<{ at: number; phaseId: string; reason: string }>, now: number): Promise<GameRecord> {
  const [log, reports, chat] = await Promise.all([playtestLog(store,attempt.id),store.call('reports',{ attemptId: attempt.id }),store.call('chatMessages',{ attemptId: attempt.id })]);
  const iso = (ms: number) => new Date(ms).toISOString(), calls = new Map(log.phases.map(p => [p.phaseId,p.calls])), talks = new Map(log.phases.map(p => [p.phaseId,p.talk]));
  const withTalk = <T extends { phaseId: string }>(phase: T) => talks.get(phase.phaseId) ? { ...phase, talk: talks.get(phase.phaseId) } : phase;
  // Reports are in play order; a phase's calls are matched by its place in the game.
  const key = (r: PublicPhaseReport) => `:${r.year}:${r.season}:${r.phase}`;
  const phases: GameRecord['phases'] = reports.map(report => { const id = [...calls.keys()].find(k => k.endsWith(key(report))) ?? key(report).slice(1); const found = calls.get(id) ?? []; calls.delete(id); return withTalk({ phaseId: id, report, calls: found }); });
  // A phase still waiting has calls but no report yet.
  for (const [phaseId, rest] of calls) phases.push(withTalk({ phaseId, report: null, calls: rest }));
  return { exportedAt: iso(now), note: 'Prompts and model reasoning are not stored, so they are not here. Each call lists the tokens the model spent reasoning.',
    attempt: { id: attempt.id, mode: attempt.mode, lifecycle: attempt.lifecycle, execution: attempt.execution, challengeId: attempt.challengeId, challengeVersion: attempt.challengeVersion,
      humanPower: challenge.definition.humanPower, objective: challenge.definition.objectiveText, preset: attempt.preset, score: attempt.score },
    opponents, phases,
    chat: chat.map(m => ({ at: iso(m.createdAt), power: m.power, from: m.sender, body: m.body, reply: m.replyState, phaseId: m.phaseId })),
    failures: failures.map(f => ({ at: iso(f.at), phaseId: f.phaseId, reason: f.reason })), models: log.models };
}
