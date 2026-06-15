import type {
  DiplomaticAgreement,
  DiplomaticMessage,
  GameState,
  LlmDiplomacyMemory,
  Order,
  Power,
  RetreatDestination,
  SubmitBuildsPayload,
} from '@diplomacy/shared';

export interface ControllerContext {
  state: GameState;
  power: Power;
  persona: string | null;
  messages: DiplomaticMessage[];
  memory: LlmDiplomacyMemory;
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
    validationErrors?: string[]
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
}) => PowerController;
