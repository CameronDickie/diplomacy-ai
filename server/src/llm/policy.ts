import type { LlmModelRole, LlmProviderId } from '@diplomacy/shared';

import { PROVIDERS, readLlmConfig } from '../../../config/runtime.cjs';

const PRICING_PER_MILLION: Partial<
  Record<LlmProviderId, Record<string, { input: number; output: number }>>
> = {
  OPENAI: {
    'gpt-5.6-terra': { input: 2.5, output: 15 },
    'gpt-5.6-luna': { input: 1, output: 6 },
    'gpt-5.5': { input: 5, output: 30 },
    'gpt-5.4': { input: 2.5, output: 15 },
    'gpt-5.4-mini': { input: 0.75, output: 4.5 },
    'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  },
  GEMINI: {
    'gemini-3.5-flash': { input: 1.5, output: 9 },
    'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
    'gemini-3-flash-preview': { input: 0.5, output: 3 },
    'gemini-2.5-flash-lite-preview-09-2025': { input: 0.1, output: 0.4 },
  },
};

export interface LlmRuntimePolicy {
  allowedProviders: Set<LlmProviderId>;
  allowedModels: Record<LlmProviderId, Set<string>>;
  defaultModels: Partial<Record<LlmProviderId, Partial<Record<LlmModelRole, string>>>>;
  maxGameSpendUsd: number;
  maxRetries: number;
  requestTimeoutMs: number;
  maxOutputTokens: number;
}

export function buildLlmRuntimePolicy(
  env: NodeJS.ProcessEnv = process.env
): LlmRuntimePolicy {
  const config = readLlmConfig(env);
  return {
    ...config,
    allowedProviders: new Set(config.allowedProviders),
    allowedModels: Object.fromEntries(PROVIDERS.map(provider => [
      provider, new Set(config.allowedModels[provider]),
    ])) as Record<LlmProviderId, Set<string>>,
  };
}

export function isProviderAllowed(
  policy: LlmRuntimePolicy,
  provider: LlmProviderId
): boolean {
  return policy.allowedProviders.has(provider);
}

export function isModelAllowed(
  policy: LlmRuntimePolicy,
  provider: LlmProviderId,
  model: string
): boolean {
  const normalized = model.trim();
  if (!normalized) return provider === 'STUB';
  return policy.allowedModels[provider]?.has(normalized) ?? false;
}

export function isModelAllowedForAnyPaidProvider(
  policy: LlmRuntimePolicy,
  model: string
): boolean {
  const normalized = model.trim();
  if (!normalized || normalized.toLowerCase() === 'idle') return true;
  return PROVIDERS.some(provider =>
    provider !== 'STUB' &&
    policy.allowedProviders.has(provider) &&
    policy.allowedModels[provider].has(normalized)
  );
}

export function resolveLlmModel(request: {
  policy: LlmRuntimePolicy;
  provider: LlmProviderId;
  requestedModel?: string | null;
  role: LlmModelRole;
}): string {
  const { policy, provider, role } = request;
  const requested = request.requestedModel?.trim() ?? '';
  if (provider === 'STUB') return requested || 'auto-hold-v0';
  if (!isProviderAllowed(policy, provider)) {
    throw new Error(`${provider} provider is not allowed by server policy`);
  }

  const lower = requested.toLowerCase();
  const explicit = requested && lower !== 'idle' && lower !== 'auto-hold-v0'
    ? requested
    : '';
  const model = explicit || policy.defaultModels[provider]?.[role];
  if (!model) {
    throw new Error(`No default model configured for ${provider} ${role}`);
  }
  if (!isModelAllowed(policy, provider, model)) {
    throw new Error(`${provider} model ${model} is not allowed by server policy`);
  }
  return model;
}

export function estimateLlmCostUsd(request: {
  provider: LlmProviderId;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}): number | null {
  if (request.inputTokens === null && request.outputTokens === null) return null;
  const price = PRICING_PER_MILLION[request.provider]?.[request.model];
  if (!price) return null;
  const inputTokens = request.inputTokens ?? 0;
  const outputTokens = request.outputTokens ?? 0;
  return ((inputTokens * price.input) + (outputTokens * price.output)) / 1_000_000;
}
