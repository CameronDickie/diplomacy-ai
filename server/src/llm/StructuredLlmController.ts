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
  DiplomaticInitiativeDecision,
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
    private readonly provider: LlmProvider
  ) {}

  async requestDiplomaticInitiative(
    context: ControllerContext,
    eligiblePowers: Power[],
    validationErrors: string[] = []
  ): Promise<DiplomaticInitiativeDecision> {
    const result = await this.provider.completeJson<{
      toPower: Power | null;
      message: string;
      strategicSummary: string;
      agreements: AgreementOutput[];
    }>({
      model: this.model,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: [
        buildControllerPrompt(context, 'DIPLOMACY', validationErrors),
        `You may initiate one brief private conversation with one of these LLM powers: ${eligiblePowers.join(', ')}.`,
        'Choose the most strategically relevant recipient. Set toPower to null and message to an empty string if no outreach is useful.',
        'Do not contact human powers in this autonomous negotiation round.',
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
    validationErrors: string[] = []
  ): Promise<DiplomaticReplyDecision> {
    const result = await this.provider.completeJson<{
      reply: string;
      strategicSummary: string;
      agreements: AgreementOutput[];
    }>({
      model: this.model,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: `${buildControllerPrompt(context, 'DIPLOMACY', validationErrors)}\nIncoming message: ${incomingMessage.body}`,
      schemaName: 'diplomacy_reply',
      schema: diplomacyReplySchema,
    });
    return {
      ...result.value,
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
      actions: OrderOutput[];
    }>({
      model: this.model,
      system: CONTROLLER_SYSTEM_PROMPT,
      prompt: buildControllerPrompt(context, 'ORDERS', validationErrors),
      schemaName: 'diplomacy_orders',
      schema: ordersSchema,
    });
    return {
      actions: result.value.actions.map(action => ({
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
  required: ['reply', 'strategicSummary', 'agreements'],
  properties: {
    reply: { type: 'string' },
    ...commonDecisionProperties,
  },
};

function diplomacyInitiativeSchema(eligiblePowers: Power[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['toPower', 'message', 'strategicSummary', 'agreements'],
    properties: {
      toPower: {
        anyOf: [
          { type: 'string', enum: eligiblePowers },
          { type: 'null' },
        ],
      },
      message: { type: 'string' },
      ...commonDecisionProperties,
    },
  };
}

const ordersSchema = {
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
