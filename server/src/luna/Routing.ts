import type { DecisionContext, DecisionProvider } from '../attempts/AttemptService.js';
import type { PhaseDecisions } from '../attempts/types.js';
import type { Store } from '../storage/Store.js';

/**
 * Chooses the opponent provider from the attempt's stored, immutable mode. A sponsored attempt is
 * never decided by the practice provider: if sponsored play is not configured in this process the
 * phase fails and stays recoverable.
 */
export function routedDecisions(store: Store, practice: DecisionProvider, sponsored: DecisionProvider | null): DecisionProvider {
  const pick = async ({ job }: DecisionContext): Promise<DecisionProvider> => {
    const attempt = await store.call('attempt',{ id: job.attemptId });
    if (!attempt) throw new Error('Attempt is no longer available.');
    if (attempt.mode === 'PRACTICE') return practice;
    if (!sponsored) throw new Error('Sponsored play is not configured in this deployment.');
    return sponsored;
  };
  return {
    decide: async (context): Promise<PhaseDecisions> => (await pick(context)).decide(context),
    recover: async (context): Promise<PhaseDecisions> => (await pick(context)).recover(context),
  };
}
