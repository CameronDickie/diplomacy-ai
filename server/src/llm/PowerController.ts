import type {
  DiplomaticAgreement,
  DiplomaticMessage,
  GameState,
  LlmDiplomacyMemory,
  LlmModelRole,
  Order,
  Power,
  RetreatDestination,
  SubmitBuildsPayload,
} from '@diplomacy/shared';
import type { MoveSuggestion } from './MoveSuggestionEngine.js';

export interface ControllerContext {
  state: GameState;
  power: Power;
  persona: string | null;
  messages: DiplomaticMessage[];
  memory: LlmDiplomacyMemory;
  moveSuggestions?: MoveSuggestion[];
}

export interface ControllerDecision<T> {
  actions: T;
  strategicSummary: string;
  agreements: DiplomaticAgreement[];
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export interface DiplomaticReplyDecision {
  reply: string;
  expectsReply?: boolean;
  strategicSummary: string;
  agreements: DiplomaticAgreement[];
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export interface DiplomaticInitiativeDecision {
  toPower: Power | null;
  message: string;
  expectsReply?: boolean;
  strategicSummary: string;
  agreements: DiplomaticAgreement[];
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export interface DiplomaticMemoryDecision {
  strategicSummary: string;
  agreements: DiplomaticAgreement[];
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export interface DiplomaticConversationContext {
  messageNumber: number;
  maxMessages: number;
  warningAtMessages: number;
}

export interface PowerController {
  readonly power: Power;
  requestDiplomaticInitiative(
    context: ControllerContext,
    eligiblePowers: Power[],
    validationErrors?: string[],
    options?: { allowHumanTargets?: boolean }
  ): Promise<DiplomaticInitiativeDecision>;
  requestDiplomaticReply(
    context: ControllerContext,
    incomingMessage: DiplomaticMessage,
    conversation?: DiplomaticConversationContext,
    validationErrors?: string[]
  ): Promise<DiplomaticReplyDecision>;
  reconcileDiplomaticMemory?(
    context: ControllerContext
  ): Promise<DiplomaticMemoryDecision>;
  requestOrders(
    context: ControllerContext,
    validationErrors?: string[]
  ): Promise<ControllerDecision<Order[]>>;
  requestRetreats(
    context: ControllerContext,
    validationErrors?: string[]
  ): Promise<ControllerDecision<Record<string, RetreatDestination | null>>>;
  requestBuilds(
    context: ControllerContext,
    validationErrors?: string[]
  ): Promise<ControllerDecision<Omit<SubmitBuildsPayload, 'gameId'>>>;
}

export interface LlmProviderResult<T> {
  value: T;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

export interface LlmProvider {
  readonly id: string;
  completeJson<T>(request: {
    model: string;
    timeoutMs?: number;
    maxOutputTokens?: number;
    system: string;
    prompt: string;
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<LlmProviderResult<T>>;
}

export type PowerControllerFactory = (options: {
  power: Power;
  provider: string;
  model: string;
  modelRole?: LlmModelRole;
  timeoutMs?: number;
  maxOutputTokens?: number;
}) => PowerController;
