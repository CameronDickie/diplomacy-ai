import type { LlmModelRole, LlmProviderId } from '@diplomacy/shared';

const PROVIDERS: LlmProviderId[] = [
  'STUB',
  'OPENAI',
  'GEMINI',
  'ANTHROPIC',
  'OPENROUTER',
  'OLLAMA',
];

const ROLE_DEFAULTS: Record<
  Extract<LlmProviderId, 'OPENAI' | 'GEMINI'>,
  Record<LlmModelRole, string>
> = {
  OPENAI: {
    DIPLOMACY_INITIATIVE: 'gpt-5.4-nano',
    DIPLOMACY_REPLY: 'gpt-5.4-mini',
    ORDERS: 'gpt-5.4-mini',
    RETREATS: 'gpt-5.4-nano',
    BUILDS: 'gpt-5.4-nano',
    MEMORY: 'gpt-5.4-mini',
  },
  GEMINI: {
    DIPLOMACY_INITIATIVE: 'gemini-3.1-flash-lite',
    DIPLOMACY_REPLY: 'gemini-3.1-flash-lite',
    ORDERS: 'gemini-3.1-flash-lite',
    RETREATS: 'gemini-3.1-flash-lite',
    BUILDS: 'gemini-3.1-flash-lite',
    MEMORY: 'gemini-3.1-flash-lite',
  },
};

const DEFAULT_ALLOWED_MODELS: Record<LlmProviderId, string[]> = {
  STUB: ['auto-hold-v0', 'idle'],
  OPENAI: ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4'],
  GEMINI: ['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash'],
  ANTHROPIC: [],
  OPENROUTER: [],
  OLLAMA: [],
};

const PRICING_PER_MILLION: Partial<
  Record<LlmProviderId, Record<string, { input: number; output: number }>>
> = {
  OPENAI: {
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
  const allowedProviders = new Set<LlmProviderId>(
    parseList(env.LLM_ALLOWED_PROVIDERS ?? 'STUB,OPENAI,GEMINI')
      .map(provider => provider.toUpperCase())
      .filter((provider): provider is LlmProviderId =>
        PROVIDERS.includes(provider as LlmProviderId)
      )
  );

  const allowedModels = Object.fromEntries(
    PROVIDERS.map(provider => {
      const configured = parseList(
        env[`LLM_ALLOWED_MODELS_${provider}`] ??
        env[`${provider}_ALLOWED_MODELS`] ??
        env.LLM_ALLOWED_MODELS ??
        DEFAULT_ALLOWED_MODELS[provider].join(',')
      );
      return [provider, new Set(configured)];
    })
  ) as Record<LlmProviderId, Set<string>>;

  const defaultModels: LlmRuntimePolicy['defaultModels'] = {};
  for (const provider of ['OPENAI', 'GEMINI'] as const) {
    defaultModels[provider] = {};
    for (const role of Object.keys(ROLE_DEFAULTS[provider]) as LlmModelRole[]) {
      defaultModels[provider]![role] =
        env[`LLM_${provider}_${role}_MODEL`] ??
        env[`LLM_${role}_MODEL`] ??
        env[`LLM_DEFAULT_${provider}_MODEL`] ??
        ROLE_DEFAULTS[provider][role];
    }
  }

  return {
    allowedProviders,
    allowedModels,
    defaultModels,
    maxGameSpendUsd: finiteNumber(env.LLM_MAX_GAME_COST_USD, 5),
    maxRetries: Math.max(0, Math.min(3, integer(env.LLM_MAX_RETRIES, 1))),
    requestTimeoutMs: Math.max(5_000, integer(env.LLM_REQUEST_TIMEOUT_MS, 90_000)),
    maxOutputTokens: Math.max(256, integer(env.LLM_MAX_OUTPUT_TOKENS, 2048)),
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

function parseList(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function integer(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function finiteNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
