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
  /** The staging check's production image playing sponsored attempts against the mock, on .test origins only. */
  stagingStandIn: boolean;
  /** Development only: opponent powers assigned to a preset other than the default. */
  playtestOpponents: Partial<Record<import('@diplomacy/shared').Power, 'luna' | 'haiku'>>;
  /** Development only: a sign-in that needs no identity provider. */
  devLogin: boolean;
  /** Development only: private messages to opponents, each answered by a paid model call. */
  playtestChat: boolean;
  /** Messages a player may send in one attempt. */
  chatMessageLimit: number;
  sponsoredPreset: 'luna' | 'haiku';
  idleWarnMinutes: number;
  idleExpireMinutes: number;
  maxActiveAttempts: number;
  maxActivePerAccount: number;
  /** Showcase only: games with friends and against practice bots on the public site. */
  showcaseGames: boolean;
  /** Hosted games held in memory at once, and games one account may host (enforced in showcase). */
  maxRooms: number;
  maxRoomsPerAccount: number;
  /** The folder of published AI game records served at /game-records/, or empty for none. */
  publishedGamesDir: string;
  dailyStartLimit: number;
  resultRetentionDays: number;
  diagnosticRetentionDays: number;
  receiptRetentionDays: number;
}
export function readLlmConfig(env?: NodeJS.ProcessEnv): LlmConfig;
export function readRuntimeConfig(env?: NodeJS.ProcessEnv, options?: { production?: boolean }): RuntimeConfig;


export function readEngineConfig(env?: NodeJS.ProcessEnv): RuntimeConfig['engine'];
