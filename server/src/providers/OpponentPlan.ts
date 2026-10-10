import { createHash } from 'node:crypto';
import type { Power } from '@diplomacy/shared';
import { opponentContract, type OpponentContract } from './OpponentContract.js';

/**
 * Which pinned contract decides each opponent power in an attempt. Production uses one contract for
 * every power; a development playtest may assign them per power to compare models in one game.
 * The plan's id and price version are what an attempt is pinned to, so an attempt started under one
 * assignment is never continued under another.
 */
export interface OpponentPlan {
  id: string;
  pricingVersion: string;
  mixed: boolean;
  contracts: readonly OpponentContract[];
  contractFor(power: Power): OpponentContract;
  /** The dearest single call any power could make; one of these must be available to start. */
  reservationNanousd: number;
  maxConcurrentDecisions: number;
}

const worstCase = (contract: OpponentContract) => contract.reservationNanousd(contract.preset.maxInputTokens);

/** Every power on one contract. Pinned exactly as that contract always was. */
export function singlePlan(contract: OpponentContract): OpponentPlan {
  return Object.freeze({ id: contract.preset.id, pricingVersion: contract.preset.pricingVersion, mixed: false, contracts: [contract],
    contractFor: () => contract, reservationNanousd: worstCase(contract), maxConcurrentDecisions: contract.preset.maxConcurrentDecisions });
}

/**
 * Per-power contracts for a development playtest. Powers not named use the fallback. The identity
 * covers the whole assignment and every contract's own id and prices, so changing any of them is a
 * different plan.
 */
export function mixedPlan(assignments: Readonly<Partial<Record<Power, string>>>, fallback: OpponentContract): OpponentPlan {
  const byPower = new Map<Power, OpponentContract>();
  for (const [power, key] of Object.entries(assignments) as Array<[Power, string]>) byPower.set(power, opponentContract(key));
  const contracts = [...new Set([fallback, ...byPower.values()])];
  if (contracts.length === 1) return singlePlan(fallback);
  const digest = (parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
  const assigned = [...byPower].sort(([a], [b]) => a.localeCompare(b)).map(([power, c]) => `${power}=${c.preset.id}`);
  return Object.freeze({
    id: `playtest-mix-${digest([`*=${fallback.preset.id}`, ...assigned])}`,
    pricingVersion: `playtest-mix-${digest(contracts.map(c => `${c.preset.id}@${c.preset.pricingVersion}`).sort())}`,
    mixed: true, contracts,
    contractFor: (power: Power) => byPower.get(power) ?? fallback,
    reservationNanousd: Math.max(...contracts.map(worstCase)),
    maxConcurrentDecisions: Math.min(...contracts.map(c => c.preset.maxConcurrentDecisions)),
  });
}
