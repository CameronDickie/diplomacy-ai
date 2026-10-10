import type { LlmModelRole, LlmProviderId } from '@diplomacy/shared';
export const SUPPORTED_ENV_NAMES: readonly string[];
export const PROVIDERS: readonly LlmProviderId[];
export const ROLES: readonly LlmModelRole[];
export interface LlmConfig {
  paidEnabled: boolean;
  configuredProviders: LlmProviderId[];
  allowedProviders: LlmProviderId[];
  allowedModels: Record<LlmProviderId, string[]>;
  defaultModels: Partial<Record<LlmProviderId, Partial<Record<LlmModelRole, string>>>>;
  ollamaBaseUrl: string;
  maxGameSpendUsd: number;
  totalBudgetUsd: number;
  maxRetries: number;
  requestTimeoutMs: number;
  maxOutputTokens: number;
  maxInputTokens: number;
}
export interface RuntimeConfig {
  profile: 'showcase' | 'private' | 'local';
  production: boolean;
  host: string;
  port: number;
  llm: LlmConfig;
  authEnabled: boolean;
  callbackOrigin: string;
  returnOrigin: string;
  corsOrigins: string[];
  cookieSecure: boolean;
  databasePath: string;
  discord: { enabled: boolean; voiceEnabled: boolean; voiceDebug: boolean; autoListen: boolean };
  engine: { path: string; concurrency: number; maxQueue: number; timeoutMs: number; maxOutputBytes: number };
  notifyMode: 'outbox' | 'resend';
  admins: string[];
  trustedProxy: 'none' | 'private';
  lunaTransport: 'none' | 'mock' | 'live';
  /** Development only: opponent powers assigned to a preset other than the default. */
  playtestOpponents: Partial<Record<import('@diplomacy/shared').Power, 'luna' | 'haiku'>>;
  /** Development only: a sign-in that needs no identity provider. */
  devLogin: boolean;
  sponsoredPreset: 'luna' | 'haiku';
  idleWarnMinutes: number;
  idleExpireMinutes: number;
  maxActiveAttempts: number;
  maxActivePerAccount: number;
  dailyStartLimit: number;
  resultRetentionDays: number;
  diagnosticRetentionDays: number;
  receiptRetentionDays: number;
}
export function readLlmConfig(env?: NodeJS.ProcessEnv): LlmConfig;
export function readRuntimeConfig(env?: NodeJS.ProcessEnv, options?: { production?: boolean }): RuntimeConfig;

export function assertRuntimeReady(config: RuntimeConfig): void;

export function readEngineConfig(env?: NodeJS.ProcessEnv): RuntimeConfig['engine'];
