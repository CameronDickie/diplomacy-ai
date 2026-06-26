import { randomUUID } from 'crypto';
import type {
  Coast,
  DiplomaticAgreement,
  Order,
  OrderType,
  Power,
  RetreatDestination,
  SubmitBuildsPayload,
  TerritoryId,
  UnitType,
} from '@diplomacy/shared';
import {
  CONTROLLER_SYSTEM_PROMPT,
  buildControllerPrompt,
} from './PromptBuilder.js';
import type {
  ControllerContext,
  ControllerDecision,
  DiplomaticConversationContext,
  DiplomaticInitiativeDecision,
  DiplomaticMemoryDecision,
  DiplomaticReplyDecision,
  LlmProvider,
  PowerController,
} from './PowerController.js';

interface AgreementOutput {
  id: string;
  parties: Power[];
  summary: string;
  status: DiplomaticAgreement['status'];
  sourceMessageIds: string[];
  expiresYear: number | null;
  expiresSeason: 'SPRING' | 'FALL' | 'WINTER' | null;
}

interface OrderOutput {
  unitTerritory: TerritoryId;
  unitCoast: Coast | null;
  type: OrderType;
  targetTerritory: TerritoryId | null;
  targetCoast: Coast | null;
  supportedUnit: TerritoryId | null;
  supportedDestination: TerritoryId | null;
  viaConvoy: boolean;
}

export class StructuredLlmController implements PowerController {
  constructor(
    readonly power: Power,
    private readonly model: string,
    private readonly provider: LlmProvider,
    private readonly runtime: {
      timeoutMs?: number;
      maxOutputTokens?: number;
    } = {}
  ) {}

  async requestDiplomaticInitiative(
    context: ControllerContext,
    eligiblePowers: Power[],
    validationErrors: string[] = [],
    options: { allowHumanTargets?: boolean } = {}
  ): Promise<DiplomaticInitiativeDecision> {
    const result = await this.provider.completeJson<{
      toPower: Power | null;
      message: string;
      expectsReply: boolean;
      strategicSummary: string;
      agreements: AgreementOutput[];
    }>({
      model: this.model,
      timeoutMs: this.runtime.timeoutMs,
      maxOutputTokens: this.runtime.maxOutputTokens,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: [
        buildControllerPrompt(context, 'DIPLOMACY', validationErrors),
        options.allowHumanTargets
          ? `You may initiate one brief private conversation with one of these powers: ${eligiblePowers.join(', ')}.`
          : `You may initiate one brief private conversation with one of these LLM powers: ${eligiblePowers.join(', ')}.`,
        'Choose the most strategically relevant recipient. Set toPower to null and message to an empty string if no outreach is useful.',
        'Set expectsReply to true only when the other power needs to answer before you can finalize your orders.',
        options.allowHumanTargets
          ? 'Human players may ignore outreach. Be concise and make the strategic reason to reply clear.'
          : 'Do not contact human powers in this autonomous negotiation round.',
      ].join('\n'),
      schemaName: 'diplomacy_initiative',
      schema: diplomacyInitiativeSchema(eligiblePowers),
    });
    return {
      ...result.value,
      agreements: toAgreements(result.value.agreements, context),
      usage: result.usage,
    };
  }

  async requestDiplomaticReply(
    context: ControllerContext,
    incomingMessage: { body: string },
    conversation?: DiplomaticConversationContext,
    validationErrors: string[] = []
  ): Promise<DiplomaticReplyDecision> {
    const result = await this.provider.completeJson<{
      reply: string;
      expectsReply: boolean;
      strategicSummary: string;
      agreements: AgreementOutput[];
    }>({
      model: this.model,
      timeoutMs: this.runtime.timeoutMs,
      maxOutputTokens: this.runtime.maxOutputTokens,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: [
        buildControllerPrompt(context, 'DIPLOMACY', validationErrors),
        `Incoming message: ${incomingMessage.body}`,
        conversation
          ? conversationInstruction(conversation)
          : 'Set expectsReply to true only if a further answer is strategically necessary.',
      ].join('\n'),
      schemaName: 'diplomacy_reply',
      schema: diplomacyReplySchema,
    });
    return {
      ...result.value,
      agreements: toAgreements(result.value.agreements, context),
      usage: result.usage,
    };
  }

  async reconcileDiplomaticMemory(
    context: ControllerContext
  ): Promise<DiplomaticMemoryDecision> {
    const result = await this.provider.completeJson<{
      strategicSummary: string;
      agreements: AgreementOutput[];
    }>({
      model: this.model,
      timeoutMs: this.runtime.timeoutMs,
      maxOutputTokens: this.runtime.maxOutputTokens,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: [
        buildControllerPrompt(context, 'DIPLOMACY'),
        'Reconcile the completed voice transcript into private memory.',
        'Update the concise strategic summary and agreement ledger. Do not write a reply.',
      ].join('\n'),
      schemaName: 'diplomacy_memory',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['strategicSummary', 'agreements'],
        properties: commonDecisionProperties,
      },
    });
    return {
      strategicSummary: result.value.strategicSummary,
      agreements: toAgreements(result.value.agreements, context),
      usage: result.usage,
    };
  }

  async requestOrders(
    context: ControllerContext,
    validationErrors: string[] = []
  ): Promise<ControllerDecision<Order[]>> {
    const result = await this.provider.completeJson<{
      strategicSummary: string;
      agreements: AgreementOutput[];
      selectedSuggestionId: string | null;
      actions: OrderOutput[];
    }>({
      model: this.model,
      timeoutMs: this.runtime.timeoutMs,
      maxOutputTokens: this.runtime.maxOutputTokens,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: buildControllerPrompt(context, 'ORDERS', validationErrors),
      schemaName: 'diplomacy_orders',
      schema: ordersSchema,
    });
    const selectedSuggestion = result.value.selectedSuggestionId
      ? context.moveSuggestions?.find(
          suggestion => suggestion.id === result.value.selectedSuggestionId
        )
      : undefined;
    return {
      actions: selectedSuggestion
        ? selectedSuggestion.orders.map(order => ({ ...order, id: randomUUID() }))
        : result.value.actions.map(action => ({
            id: randomUUID(),
            power: this.power,
            ...action,
          })),
      strategicSummary: result.value.strategicSummary,
      agreements: toAgreements(result.value.agreements, context),
      usage: result.usage,
    };
  }

  async requestRetreats(
    context: ControllerContext,
    validationErrors: string[] = []
  ): Promise<ControllerDecision<Record<string, RetreatDestination | null>>> {
    const result = await this.provider.completeJson<{
      strategicSummary: string;
      agreements: AgreementOutput[];
      actions: Array<{ unitId: string; territory: TerritoryId | null; coast: Coast | null }>;
    }>({
      model: this.model,
      timeoutMs: this.runtime.timeoutMs,
      maxOutputTokens: this.runtime.maxOutputTokens,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: buildControllerPrompt(context, 'RETREATS', validationErrors),
      schemaName: 'diplomacy_retreats',
      schema: retreatsSchema,
    });
    return {
      actions: Object.fromEntries(
        result.value.actions.map(action => [
          action.unitId,
          action.territory ? { territory: action.territory, coast: action.coast } : null,
        ])
      ),
      strategicSummary: result.value.strategicSummary,
      agreements: toAgreements(result.value.agreements, context),
      usage: result.usage,
    };
  }

  async requestBuilds(
    context: ControllerContext,
    validationErrors: string[] = []
  ): Promise<ControllerDecision<Omit<SubmitBuildsPayload, 'gameId'>>> {
    const result = await this.provider.completeJson<{
      strategicSummary: string;
      agreements: AgreementOutput[];
      builds: Array<{ type: UnitType; territory: TerritoryId; coast: Coast | null }>;
      disbands: string[];
    }>({
      model: this.model,
      timeoutMs: this.runtime.timeoutMs,
      maxOutputTokens: this.runtime.maxOutputTokens,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: buildControllerPrompt(context, 'BUILDS', validationErrors),
      schemaName: 'diplomacy_builds',
      schema: buildsSchema,
    });
    return {
      actions: {
        builds: result.value.builds,
        disbands: result.value.disbands,
      },
      strategicSummary: result.value.strategicSummary,
      agreements: toAgreements(result.value.agreements, context),
      usage: result.usage,
    };
  }
}

const agreementSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'parties',
    'summary',
    'status',
    'sourceMessageIds',
    'expiresYear',
    'expiresSeason',
  ],
  properties: {
    id: { type: 'string' },
    parties: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    status: { type: 'string', enum: ['PROPOSED', 'ACTIVE', 'BROKEN', 'EXPIRED'] },
    sourceMessageIds: { type: 'array', items: { type: 'string' } },
    expiresYear: { type: ['integer', 'null'] },
    expiresSeason: { type: ['string', 'null'], enum: ['SPRING', 'FALL', 'WINTER', null] },
  },
};

const commonDecisionProperties = {
  strategicSummary: { type: 'string' },
  agreements: { type: 'array', items: agreementSchema },
};

const diplomacyReplySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'expectsReply', 'strategicSummary', 'agreements'],
  properties: {
    reply: { type: 'string' },
    expectsReply: { type: 'boolean' },
    ...commonDecisionProperties,
  },
};

function diplomacyInitiativeSchema(eligiblePowers: Power[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['toPower', 'message', 'expectsReply', 'strategicSummary', 'agreements'],
    properties: {
      toPower: {
        anyOf: [
          { type: 'string', enum: eligiblePowers },
          { type: 'null' },
        ],
      },
      message: { type: 'string' },
      expectsReply: { type: 'boolean' },
      ...commonDecisionProperties,
    },
  };
}

function conversationInstruction(context: DiplomaticConversationContext): string {
  const remaining = context.maxMessages - context.messageNumber;
  const warning = context.messageNumber >= context.warningAtMessages
    ? 'The configured warning threshold has been reached. Conclude now unless another answer is essential.'
    : 'Continue only while another answer is strategically necessary.';
  return [
    `This reply will be message ${context.messageNumber} of at most ${context.maxMessages}.`,
    `${remaining} messages will remain after this reply. ${warning}`,
    'Set expectsReply to false when the exchange has reached a useful conclusion.',
  ].join(' ');
}

const ordersSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['strategicSummary', 'agreements', 'selectedSuggestionId', 'actions'],
  properties: {
    ...commonDecisionProperties,
    selectedSuggestionId: { type: ['string', 'null'] },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'unitTerritory',
          'unitCoast',
          'type',
          'targetTerritory',
          'targetCoast',
          'supportedUnit',
          'supportedDestination',
          'viaConvoy',
        ],
        properties: {
          unitTerritory: { type: 'string' },
          unitCoast: { type: ['string', 'null'] },
          type: {
            type: 'string',
            enum: ['HOLD', 'MOVE', 'SUPPORT_HOLD', 'SUPPORT_MOVE', 'CONVOY'],
          },
          targetTerritory: { type: ['string', 'null'] },
          targetCoast: { type: ['string', 'null'] },
          supportedUnit: { type: ['string', 'null'] },
          supportedDestination: { type: ['string', 'null'] },
          viaConvoy: { type: 'boolean' },
        },
      },
    },
  },
};

const retreatsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['strategicSummary', 'agreements', 'actions'],
  properties: {
    ...commonDecisionProperties,
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unitId', 'territory', 'coast'],
        properties: {
          unitId: { type: 'string' },
          territory: { type: ['string', 'null'] },
          coast: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const buildsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['strategicSummary', 'agreements', 'builds', 'disbands'],
  properties: {
    ...commonDecisionProperties,
    builds: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'territory', 'coast'],
        properties: {
          type: { type: 'string', enum: ['ARMY', 'FLEET'] },
          territory: { type: 'string' },
          coast: { type: ['string', 'null'] },
        },
      },
    },
    disbands: { type: 'array', items: { type: 'string' } },
  },
};

function toAgreements(
  agreements: AgreementOutput[],
  context: ControllerContext
): DiplomaticAgreement[] {
  return agreements.map(agreement => ({
    ...agreement,
    id: agreement.id || randomUUID(),
    createdYear: context.state.year,
    createdSeason: context.state.season,
  }));
}
