import type { PlaytestLog, PlaytestPhase } from '@diplomacy/shared';
import type { Store } from '../storage/Store.js';

/**
 * Per phase and power: which model was asked, what it chose, how long the provider took and what the
 * call cost. Built from the accounting records only; prompts and raw answers are never stored.
 */
export async function playtestLog(store: Store, attemptId: string): Promise<PlaytestLog> {
  const calls = (await store.call('providerCallsForAttempt',{ attemptId })).sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const phases: PlaytestPhase[] = [], byOperation = new Map<string, PlaytestPhase>();
  const models: PlaytestLog['models'] = {};
  for (const call of calls) {
    let phase = byOperation.get(call.fence.operationId);
    if (!phase) {
      const decisions = new Map((await store.call('providerDecisions',{ operationId: call.fence.operationId })).map(d => [d.callId,d.action]));
      phase = { phaseId: call.fence.phaseId, kind: call.role, calls: [] };
      byOperation.set(call.fence.operationId,phase); phases.push(phase);
      (phase as PlaytestPhase & { decisions?: typeof decisions }).decisions = decisions;
    }
    const decisions = (phase as PlaytestPhase & { decisions?: Map<string, unknown> }).decisions!;
    const action = decisions.get(call.id) as { orderIds?: string[]; retreats?: unknown; builds?: unknown } | undefined;
    const latencyMs = call.dispatchedAt !== null && call.receivedAt !== null ? call.receivedAt - call.dispatchedAt : null;
    phase.calls.push({ power: call.power, model: call.model, outcome: call.outcome, latencyMs,
      inputTokens: call.usage?.inputTokens ?? null, outputTokens: call.usage?.outputTokens ?? null, reasoningTokens: call.usage?.reasoningTokens ?? null,
      costNanousd: call.usage?.costNanousd ?? null, heldNanousd: call.usage ? 0 : call.dispatchedAt !== null ? call.maxCostNanousd : 0,
      decision: action ?? null });
    const total = models[call.model] ??= { calls: 0, valid: 0, costNanousd: 0, heldNanousd: 0, latencyMsTotal: 0, timedCalls: 0, outputTokens: 0 };
    total.calls++; if (call.outcome === 'VALID') total.valid++;
    total.costNanousd += call.usage?.costNanousd ?? 0; total.outputTokens += call.usage?.outputTokens ?? 0;
    if (!call.usage && call.dispatchedAt !== null) total.heldNanousd += call.maxCostNanousd;
    if (latencyMs !== null) { total.latencyMsTotal += latencyMs; total.timedCalls++; }
  }
  for (const phase of phases) delete (phase as PlaytestPhase & { decisions?: unknown }).decisions;
  return { attemptId, phases, models };
}
