import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Server } from 'socket.io';
import type {
  Power,
  GameState,
  Player,
  HumanPlayer,
  Order,
  Unit,
  ClientToServerEvents,
  ServerToClientEvents,
  SubmitRetreatsPayload,
  SubmitBuildsPayload,
  Coast,
  RetreatDestination,
  DiplomaticMessage,
  LlmDiplomacyMemory,
  LlmPlayer,
  LlmRunArtifact,
  LlmFallbackCounters,
  LlmRunSummary,
  LlmProviderId,
  LlmModelRole,
  GameSettings,
  PublicBoardSnapshot,
  PublicPhaseReport,
  RetreatResolution,
  AdjustmentResolution,
  DiplomacyTransportSource,
  TerritoryId,
  LlmOutreachRequest,
  PhaseSubmission,
  SubmissionState,
} from '@diplomacy/shared';
import {
  ALL_POWERS,
  gamePhaseId,
  TERRITORY_MAP,
} from '@diplomacy/shared';
import { buildInitialTerritories, STARTING_UNITS } from '@diplomacy/shared';
import {
  adjudicateWithGodip,
  legalOrderId,
  listLegalOrdersWithGodip,
  type LegalOrderOption,
} from './adjudication/GodipAdjudicator.js';
import type {
  ControllerContext,
  ControllerDecision,
  PowerController,
  PowerControllerFactory,
} from './llm/PowerController.js';
import { createPowerController } from './llm/createPowerController.js';
import { PROMPT_VERSION } from './llm/PromptBuilder.js';
import { suggestMoveOrderSets } from './llm/MoveSuggestionEngine.js';
import {
  BOARD_CONTEXT_VERSION,
  buildLlmBoardContext,
} from './llm/BoardContext.js';
import {
  buildLlmRuntimePolicy,
  estimateLlmCostUsd,
  isModelAllowed,
  isModelAllowedForAnyPaidProvider,
  isProviderAllowed,
  resolveLlmModel,
  type LlmRuntimePolicy,
} from './llm/policy.js';

export class GameRoom {
  readonly gameId: string;
  private state: GameState;
  private playerSessions = new Map<string, { socketId: string | null; tokenHash: string }>();
  private pendingOrders = new Map<Power, Order[]>();
  private pendingRetreats = new Map<Power, Record<string, RetreatDestination | null>>();
  private pendingBuilds = new Map<Power, SubmitBuildsPayload>();
  private submissionStates = new Map<Power, SubmissionState>();
  private submissionReceipts = new Map<string, {
    fingerprint: string;
    result: Promise<SubmissionState>;
  }>();
  private diplomaticMessages: DiplomaticMessage[] = [];
  private phaseHistory: PublicPhaseReport[] = [];
  private llmMemories = new Map<Power, LlmDiplomacyMemory>();
  private llmRunArtifacts: LlmRunArtifact[] = [];
  private legalOrderCache = new Map<string, LegalOrderOption[]>();
  private llmOutreachRequests: LlmOutreachRequest[] = [];
  private llmQueues = new Map<Power, Promise<unknown>>();
  private diplomacyParticipantLocks = new Map<Power, Promise<unknown>>();
  private voiceLocks = new Map<Power, Promise<void>>();
  private activeConversations = new Map<string, {
    id: string;
    participants: [Power, Power];
    messageCount: number;
    maxMessages: number;
    status: 'WAITING_FOR_REPLY' | 'RESPONDING' | 'AT_MESSAGE_LIMIT';
  }>();
  private ordersCompletion: Promise<void> | null = null;
  private retreatsCompletion: Promise<void> | null = null;
  private buildsCompletion: Promise<void> | null = null;
  private turnStartPlanning: Promise<void> | null = null;
  private turnStartPlanningCompletedFor = new Set<string>();
  private estimatedLlmSpendUsd = 0;
  private io?: Server<ClientToServerEvents, ServerToClientEvents>;
  private readonly controllerFactory: PowerControllerFactory;
  private readonly llmPolicy: LlmRuntimePolicy;
  private readonly enforceLlmPolicy: boolean;

  constructor(options: {
    controllerFactory?: PowerControllerFactory;
    llmPolicy?: LlmRuntimePolicy;
    enforceLlmPolicy?: boolean;
  } = {}) {
    this.gameId = randomUUID().slice(0, 8).toUpperCase();
    this.controllerFactory = options.controllerFactory ?? (controllerOptions =>
      createPowerController({
        ...controllerOptions,
        provider: controllerOptions.provider as LlmProviderId,
      })
    );
    this.llmPolicy = options.llmPolicy ?? buildLlmRuntimePolicy();
    this.enforceLlmPolicy = options.enforceLlmPolicy ?? !options.controllerFactory;
    this.state = this.buildInitialState();
  }

  private buildInitialState(): GameState {
    const units: Unit[] = STARTING_UNITS.map(u => ({
      ...u,
      id: randomUUID(),
      mustRetreat: false,
      retreatOptions: [],
      retreatCoasts: {},
      dislodgedBy: null,
    }));

    return {
      gameId: this.gameId,
      accessMode: 'PUBLIC',
      hostPlayerId: '',
      year: 1901,
      season: 'SPRING',
      phase: 'ORDERS',
      territories: buildInitialTerritories(),
      units,
      players: [],
      settings: {
        llmNegotiationInitiators: 2,
        llmNegotiationMaxMessages: 6,
        llmNegotiationWarningAtMessages: 4,
        llmNegotiationPlannerModel: '',
        publicLlmConversationPresence: false,
        voiceMaxSessionMinutes: 10,
        voiceMaxTurns: 20,
        voiceIdleTimeoutSeconds: 60,
        voiceAutoCommitSilenceSeconds: 3,
      },
      submittedPowers: [],
      lastAdjudicationResult: null,
      status: 'LOBBY',
      winner: null,
    };
  }

  setIO(io: Server<ClientToServerEvents, ServerToClientEvents>): void {
    this.io = io;
  }

  getState(): GameState {
    return this.state;
  }

  hasSocket(socketId: string): boolean {
    return [...this.playerSessions.values()].some(session => session.socketId === socketId);
  }

  getPlayerBySocket(socketId: string): HumanPlayer | undefined {
    const playerId = [...this.playerSessions.entries()].find(
      ([, session]) => session.socketId === socketId
    )?.[0];
    return this.state.players.find(
      (player): player is HumanPlayer => player.kind === 'HUMAN' && player.id === playerId
    );
  }

  getPlayerById(playerId: string): HumanPlayer | undefined {
    return this.state.players.find(
      (player): player is HumanPlayer =>
        player.kind === 'HUMAN' && player.id === playerId
    );
  }

  getLlmPlayer(power: Power): LlmPlayer | undefined {
    return this.state.players.find(
      (player): player is LlmPlayer =>
        player.kind === 'LLM' && player.power === power
    );
  }

  isHost(socketId: string): boolean {
    return this.getPlayerBySocket(socketId)?.id === this.state.hostPlayerId;
  }

  requiresAuthenticatedAccess(): boolean {
    return (
      this.state.accessMode === 'AUTHENTICATED_AI' ||
      this.state.players.some(player => player.kind === 'LLM')
    );
  }

  enableAuthenticatedAiAccess(): void {
    this.state.accessMode = 'AUTHENTICATED_AI';
  }

  validateLlmPlayerOptions(options: {
    provider?: LlmProviderId;
    model?: string;
  }): { ok: true } | { ok: false; code: string; message: string } {
    if (!this.enforceLlmPolicy) return { ok: true };
    const provider = options.provider ?? 'STUB';
    if (!isProviderAllowed(this.llmPolicy, provider)) {
      return {
        ok: false,
        code: 'AI_PROVIDER_NOT_ALLOWED',
        message: `${provider} is not allowed by this server`,
      };
    }
    if (provider === 'STUB') return { ok: true };
    const model = options.model?.trim() || this.llmPolicy.defaultModels[provider]?.ORDERS;
    if (!model || !isModelAllowed(this.llmPolicy, provider, model)) {
      return {
        ok: false,
        code: 'INVALID_LLM_MODEL',
        message: `${provider} model ${model || '(default)'} is not allowed by this server`,
      };
    }
    return { ok: true };
  }

  updateLlmNegotiationInitiators(count: number): boolean {
    return this.updateGameSettings({ llmNegotiationInitiators: count });
  }

  updateGameSettings(settings: Partial<GameSettings>): boolean {
    if (this.state.status !== 'LOBBY') return false;
    const next = { ...this.state.settings, ...settings };
    if (
      !Number.isInteger(next.llmNegotiationInitiators) ||
      next.llmNegotiationInitiators < 0 ||
      next.llmNegotiationInitiators > ALL_POWERS.length ||
      !Number.isInteger(next.llmNegotiationMaxMessages) ||
      next.llmNegotiationMaxMessages < 2 ||
      next.llmNegotiationMaxMessages > 20 ||
      !Number.isInteger(next.llmNegotiationWarningAtMessages) ||
      next.llmNegotiationWarningAtMessages < 1 ||
      next.llmNegotiationWarningAtMessages > next.llmNegotiationMaxMessages ||
      next.llmNegotiationPlannerModel.length > 100 ||
      typeof next.publicLlmConversationPresence !== 'boolean' ||
      !Number.isInteger(next.voiceMaxSessionMinutes) ||
      next.voiceMaxSessionMinutes < 1 ||
      next.voiceMaxSessionMinutes > 30 ||
      !Number.isInteger(next.voiceMaxTurns) ||
      next.voiceMaxTurns < 1 ||
      next.voiceMaxTurns > 50 ||
      !Number.isInteger(next.voiceIdleTimeoutSeconds) ||
      next.voiceIdleTimeoutSeconds < 15 ||
      next.voiceIdleTimeoutSeconds > 300 ||
      !Number.isFinite(next.voiceAutoCommitSilenceSeconds) ||
      next.voiceAutoCommitSilenceSeconds < 1 ||
      next.voiceAutoCommitSilenceSeconds > 10
    ) {
      return false;
    }
    if (
      this.enforceLlmPolicy &&
      next.llmNegotiationPlannerModel.trim() &&
      !isModelAllowedForAnyPaidProvider(this.llmPolicy, next.llmNegotiationPlannerModel)
    ) {
      return false;
    }
    this.state.settings = {
      ...next,
      llmNegotiationPlannerModel: next.llmNegotiationPlannerModel.trim(),
    };
    return true;
  }

  addPlayer(
    socketId: string,
    name: string,
    preferredPower: Power | 'RANDOM' = 'RANDOM'
  ): { player: HumanPlayer; sessionToken: string } | null {
    if (this.state.status !== 'LOBBY') return null;
    if (this.hasSocket(socketId)) return null;
    const availablePowers = this.getAvailablePowers();
    const available = preferredPower === 'RANDOM'
      ? availablePowers[Math.floor(Math.random() * availablePowers.length)]
      : availablePowers.includes(preferredPower) ? preferredPower : undefined;
    if (!available) return null;

    const playerId = randomUUID();
    const sessionToken = randomBytes(32).toString('base64url');
    const player: HumanPlayer = {
      id: playerId,
      kind: 'HUMAN',
      name: name.trim(),
      power: available,
      connected: true,
    };
    this.state.players.push(player);
    this.playerSessions.set(playerId, {
      socketId,
      tokenHash: hashToken(sessionToken),
    });
    if (!this.state.hostPlayerId) this.state.hostPlayerId = playerId;

    return { player, sessionToken };
  }

  resumePlayer(socketId: string, sessionToken: string): HumanPlayer | undefined {
    const tokenHash = hashToken(sessionToken);
    const sessionEntry = [...this.playerSessions.entries()].find(
      ([, session]) => session.tokenHash === tokenHash
    );
    if (!sessionEntry) return undefined;

    const [playerId, session] = sessionEntry;
    const existingPlayer = this.getPlayerBySocket(socketId);
    if (existingPlayer && existingPlayer.id !== playerId) return undefined;
    const previousSocketId = session.socketId;
    session.socketId = socketId;
    if (previousSocketId && previousSocketId !== socketId && this.io) {
      this.io.to(previousSocketId).emit('session_replaced', {
        code: 'SESSION_REPLACED',
        message: 'Your seat was opened in another tab or browser. Refresh this page to take control here.',
      });
      this.io.in(previousSocketId).socketsLeave(this.gameId);
    }
    const player = this.state.players.find(
      (candidate): candidate is HumanPlayer =>
        candidate.kind === 'HUMAN' && candidate.id === playerId
    );
    if (player) player.connected = true;
    return player;
  }

  addLlmPlayer(options: {
    power?: Power | 'RANDOM';
    name?: string;
    provider?: LlmProviderId;
    model?: string;
    persona?: string | null;
    realtimeModel?: string;
    voice?: string;
    voiceInstructions?: string | null;
  } = {}): Player | null {
    const validation = this.validateLlmPlayerOptions({
      provider: options.provider,
      model: options.model,
    });
    if (!validation.ok) return null;
    const availablePowers = this.getAvailablePowers();
    const requestedPower = options.power ?? 'RANDOM';
    const available = requestedPower === 'RANDOM'
      ? availablePowers[0]
      : availablePowers.includes(requestedPower) ? requestedPower : undefined;
    if (!available) return null;

    const player: Player = {
      id: randomUUID(),
      kind: 'LLM',
      name: options.name?.trim() || `${available} Bot`,
      power: available,
      provider: options.provider ?? 'STUB',
      model: options.model?.trim() || this.defaultSeatModel(options.provider ?? 'STUB'),
      persona: options.persona ?? null,
      realtimeModel: options.realtimeModel?.trim() || 'gpt-realtime-2',
      voice: normalizeRealtimeVoice(options.voice, available),
      voiceInstructions: options.voiceInstructions?.trim() || null,
    };
    this.state.players.push(player);
    this.enableAuthenticatedAiAccess();
    this.llmMemories.set(available, {
      power: available,
      revision: 0,
      updatedAt: null,
      messageIdsByPower: {},
      diplomaticContext: '',
      strategicSummary: '',
      agreements: [],
    });
    return player;
  }

  getAvailablePowers(): Power[] {
    const assignedPowers = new Set(this.state.players.map(player => player.power));
    return ALL_POWERS.filter(power => !assignedPowers.has(power));
  }

  private defaultSeatModel(provider: LlmProviderId): string {
    if (provider === 'STUB') return 'auto-hold-v0';
    return this.llmPolicy.defaultModels[provider]?.ORDERS ?? 'auto-hold-v0';
  }

  validateDiplomaticMessage(fromPower: Power, toPower: Power, body: string): string | null {
    if (this.state.status === 'FINISHED') return 'Diplomacy is closed for this game';
    if (fromPower === toPower) return 'Choose another power';
    if (!this.state.players.some(player => player.power === fromPower)) {
      return 'The sending power is not in this game';
    }
    if (!this.state.players.some(player => player.power === toPower)) {
      return 'The receiving power is not in this game';
    }
    const normalizedBody = body.trim();
    if (!normalizedBody) return 'Message cannot be empty';
    if (normalizedBody.length > 2000) return 'Message cannot exceed 2000 characters';
    return null;
  }

  async sendDiplomaticMessage(
    fromPower: Power,
    toPower: Power,
    body: string,
    clientMessageId?: string,
    source: DiplomacyTransportSource = 'WEB',
    externalMessageId: string | null = null
  ): Promise<DiplomaticMessage[]> {
    const message = this.createDiplomaticMessage(
      fromPower,
      toPower,
      body.trim(),
      false,
      clientMessageId,
      source,
      externalMessageId
    );
    const messages = [message];
    this.deliverDiplomaticMessage(message);
    this.markOpenOutreachReplied(fromPower, toPower);
    const recipient = this.state.players.find(player => player.power === toPower);

    if (recipient?.kind === 'LLM') {
      const replyMessage = await this.runSerializedDiplomacy(
        [fromPower, toPower],
        2,
        1,
        conversationId => this.runSerializedForPower(toPower, async () => {
          this.updateConversationStatus(conversationId, 'RESPONDING');
          const decision = await this.generateDiplomaticReply(recipient, message);
          this.updateConversationMessageCount(conversationId, 2);
          const reply = this.createDiplomaticMessage(
            toPower,
            fromPower,
            decision.reply,
            true,
            randomUUID(),
            source
          );
          this.deliverDiplomaticMessage(reply);
          return reply;
        })
      );
      messages.push(replyMessage);
    }

    return messages;
  }

  getDiplomaticMessages(power: Power): DiplomaticMessage[] {
    return this.diplomaticMessages
      .filter(message => message.fromPower === power || message.toPower === power)
      .map(message => ({ ...message }));
  }

  recordVoiceTranscript(
    fromPower: Power,
    toPower: Power,
    body: string,
    automated: boolean,
    externalMessageId: string | null = null
  ): DiplomaticMessage {
    const message = this.createDiplomaticMessage(
      fromPower,
      toPower,
      body.trim(),
      automated,
      randomUUID(),
      'DISCORD_VOICE',
      externalMessageId
    );
    this.deliverDiplomaticMessage(message);
    return message;
  }

  async beginVoiceLock(power: Power, otherPower: Power): Promise<() => void> {
    if (this.voiceLocks.has(power)) {
      throw new Error(`${power} is already in a voice conversation`);
    }
    let release!: () => void;
    const lock = new Promise<void>(resolve => {
      release = resolve;
    });
    this.voiceLocks.set(power, lock);
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    void this.runSerializedDiplomacy(
      [otherPower, power],
      0,
      0,
      async conversationId => {
        this.updateConversationStatus(conversationId, 'WAITING_FOR_REPLY');
        markStarted();
        await lock;
      }
    );
    await started;
    return () => {
      if (this.voiceLocks.get(power) !== lock) return;
      this.voiceLocks.delete(power);
      release();
    };
  }

  isVoiceBusy(power: Power): boolean {
    return this.voiceLocks.has(power);
  }

  buildVoiceSessionInstructions(power: Power, otherPower: Power): string {
    const player = this.getLlmPlayer(power);
    const memory = this.llmMemories.get(power);
    if (!player || !memory) throw new Error(`${power} is not an LLM power`);
    return [
      `You are speaking as ${power} in a standard game of Diplomacy.`,
      `The other speaker controls ${otherPower}.`,
      player.persona ? `Persona: ${player.persona}` : '',
      player.voiceInstructions ?? '',
      'Negotiate naturally and strategically. Keep each spoken turn concise enough for live conversation.',
      'Think silently before responding. Do not say you need a moment to think; give your substantive answer in the same spoken turn.',
      'Use full spoken territory names such as Rumania and Bulgaria, never board abbreviations.',
      'Do not claim that an agreement is mechanically binding.',
      `Private strategic summary: ${memory.strategicSummary || 'None yet.'}`,
      `Current agreements: ${JSON.stringify(memory.agreements)}`,
      `Private conversation context: ${memory.diplomaticContext || 'No previous messages.'}`,
    ].filter(Boolean).join('\n');
  }

  async reconcileVoiceMemory(power: Power): Promise<void> {
    const player = this.getLlmPlayer(power);
    if (!player) throw new Error(`${power} is not an LLM power`);
    const model = this.resolveControllerModel(player, 'MEMORY');
    const controller = this.controllerFor(player, 'MEMORY', model);
    if (!controller.reconcileDiplomaticMemory) return;

    const started = Date.now();
    const artifact = this.createRunArtifact(player, 'DIPLOMACY', 'MEMORY', model);
    this.recordRunStatus(artifact, 'THINKING');
    if (!this.canSpendForLlmRun(artifact)) return;
    try {
      const decision = await controller.reconcileDiplomaticMemory(
        this.controllerContext(player)
      );
      this.applyControllerMemory(power, decision);
      this.completeRunArtifact(artifact, decision, {
        kind: 'VOICE_MEMORY_RECONCILIATION',
      });
      this.recordRunUsage(artifact, decision.usage);
      artifact.latencyMs = Date.now() - started;
      this.recordRunStatus(artifact, 'COMPLETE');
      this.recordLlmRunArtifact(artifact);
    } catch (error) {
      artifact.fallbackReason = error instanceof Error ? error.message : String(error);
      artifact.latencyMs = Date.now() - started;
      this.recordRunStatus(artifact, 'FALLBACK');
      this.recordRunStatus(artifact, 'COMPLETE');
      this.recordLlmRunArtifact(artifact);
      throw error;
    }
  }

  getLlmDiplomacyMemory(power: Power): LlmDiplomacyMemory | undefined {
    const memory = this.llmMemories.get(power);
    if (!memory) return undefined;
    return {
      ...memory,
      messageIdsByPower: Object.fromEntries(
        Object.entries(memory.messageIdsByPower).map(([otherPower, ids]) => [
          otherPower,
          [...ids],
        ])
      ),
      agreements: memory.agreements.map(agreement => ({ ...agreement })),
    };
  }

  getLlmRunArtifacts(power?: Power): LlmRunArtifact[] {
    return structuredClone(
      this.llmRunArtifacts.filter(artifact => !power || artifact.power === power)
    );
  }

  getLlmFallbackCounters(): LlmFallbackCounters {
    const byPurpose: LlmFallbackCounters['byPurpose'] = {
      DIPLOMACY: { totalRuns: 0, fallbackRuns: 0 },
      ORDERS: { totalRuns: 0, fallbackRuns: 0 },
      RETREATS: { totalRuns: 0, fallbackRuns: 0 },
      BUILDS: { totalRuns: 0, fallbackRuns: 0 },
    };
    let fallbackRuns = 0;
    let totalRetries = 0;
    for (const artifact of this.llmRunArtifacts) {
      const purpose = byPurpose[artifact.purpose];
      purpose.totalRuns++;
      totalRetries += artifact.retryCount;
      if (artifact.fallbackReason) {
        fallbackRuns++;
        purpose.fallbackRuns++;
      }
    }
    const totalRuns = this.llmRunArtifacts.length;
    return {
      totalRuns,
      successfulRuns: totalRuns - fallbackRuns,
      fallbackRuns,
      fallbackRate: totalRuns === 0 ? 0 : fallbackRuns / totalRuns,
      totalRetries,
      byPurpose,
    };
  }

  getLlmOutreachRequests(power?: Power): LlmOutreachRequest[] {
    return structuredClone(
      this.llmOutreachRequests.filter(request =>
        !power || request.fromPower === power || request.toPower === power
      )
    );
  }

  getPhaseHistory(): PublicPhaseReport[] {
    return structuredClone(this.phaseHistory);
  }

  deliverDiplomaticMessage(message: DiplomaticMessage): void {
    if (!this.io) return;
    const deliveredSocketIds = new Set<string>();
    for (const power of [message.fromPower, message.toPower]) {
      const socketId = this.getSocketIdForPower(power);
      if (!socketId || deliveredSocketIds.has(socketId)) continue;
      deliveredSocketIds.add(socketId);
      this.io.to(socketId).emit('diplomacy_message', { message });
    }
  }

  emitToPlayer<Ev extends keyof ServerToClientEvents>(
    playerId: string,
    event: Ev,
    data: Parameters<ServerToClientEvents[Ev]>[0]
  ): void {
    if (!this.io) return;
    const socketId = this.playerSessions.get(playerId)?.socketId;
    if (!socketId) return;
    const target = this.io.to(socketId) as unknown as {
      emit: (event: string, payload: unknown) => void;
    };
    target.emit(event as string, data);
  }

  canStart(): boolean {
    return ALL_POWERS.every(power => this.state.players.some(p => p.power === power));
  }

  async startGame(): Promise<boolean> {
    if (this.state.status !== 'LOBBY' || !this.canStart()) return false;
    this.state.status = 'IN_PROGRESS';
    this.scheduleTurnStartPlanning();
    await this.completeOrdersPhaseIfReady();
    return true;
  }

  markDisconnected(socketId: string): void {
    const player = this.getPlayerBySocket(socketId);
    if (player) {
      player.connected = false;
      const session = this.playerSessions.get(player.id);
      if (session) session.socketId = null;
    }
  }

  async submitOrders(power: Power, orders: Order[]): Promise<void> {
    if (this.state.status !== 'IN_PROGRESS') return;
    if (this.state.phase !== 'ORDERS') return;
    if (this.state.submittedPowers.includes(power)) return;

    this.markOpenOutreachIgnored(power);
    this.pendingOrders.set(power, orders);
    this.state.submittedPowers = [...this.state.submittedPowers, power];

    const activePowers = this.getPowersWithUnits();

    this.broadcast('power_submitted', {
      power,
      totalSubmitted: this.state.submittedPowers.length,
      totalRequired: activePowers.length,
    });

    try {
      await this.completeOrdersPhaseIfReady();
    } catch (error) {
      this.pendingOrders.delete(power);
      this.state.submittedPowers = this.state.submittedPowers.filter(
        submittedPower => submittedPower !== power
      );
      this.broadcast('game_state_sync', { gameState: this.state });
      throw error;
    }
  }

  getSubmissionState(power: Power): SubmissionState {
    const phaseId = gamePhaseId(this.state);
    const saved = this.submissionStates.get(power);
    return saved?.phaseId === phaseId ? structuredClone(saved) : {
      phaseId, requestId: null, status: 'EDITING', error: null,
    };
  }

  /** Reserve before awaiting: repeated deliveries share one resolution attempt. */
  submitCommand(power: Power, command: PhaseSubmission): Promise<SubmissionState> {
    const key = `${power}:${command.requestId}`;
    const fingerprint = JSON.stringify(command);
    const existing = this.submissionReceipts.get(key);
    if (existing) {
      if (existing.fingerprint === fingerprint) return existing.result.then(value => structuredClone(value));
      return Promise.resolve({
        phaseId: command.phaseId, requestId: command.requestId, status: 'FAILED',
        error: { code: 'REQUEST_ID_REUSED', message: 'This request ID was already used for a different submission.' },
      });
    }
    const failed = (code: string, message: string): SubmissionState => ({
      phaseId: command.phaseId, requestId: command.requestId, status: 'FAILED', error: { code, message },
    });
    if (command.phaseId !== gamePhaseId(this.state)) {
      return Promise.resolve(failed('STALE_PHASE', 'The turn changed. Review the current board and submit again.'));
    }
    if (this.state.status !== 'IN_PROGRESS' || command.phase !== this.state.phase) {
      return Promise.resolve(failed('WRONG_PHASE', 'Submissions are not open for this phase.'));
    }
    const current = this.getSubmissionState(power);
    if (current.status === 'SUBMITTING' || current.status === 'ACCEPTED') {
      return Promise.resolve(current);
    }
    const pending: SubmissionState = {
      phaseId: command.phaseId, requestId: command.requestId, status: 'SUBMITTING', error: null,
    };
    this.submissionStates.set(power, pending);
    // Starting in a microtask makes the reservation visible before work begins.
    const result = Promise.resolve().then(async (): Promise<SubmissionState> => {
      let outcome: SubmissionState;
      try {
        const error = command.phase === 'ORDERS' ? this.validateOrders(power, command.orders)
          : command.phase === 'RETREATS' ? this.validateRetreats(power, command.retreats)
          : this.validateBuilds(power, { gameId: this.gameId, builds: command.builds, disbands: command.disbands });
        if (error) {
          outcome = failed(`INVALID_${command.phase}`, error);
        } else {
          if (command.phase === 'ORDERS') await this.submitOrders(power, command.orders);
          else if (command.phase === 'RETREATS') await this.submitRetreats(power, command.retreats);
          else await this.submitBuilds(power, { gameId: this.gameId, builds: command.builds, disbands: command.disbands });
          outcome = { ...pending, status: 'ACCEPTED' };
        }
      } catch (error) {
        console.error(`Submission resolution failed in ${this.gameId}:`, error instanceof Error ? error.name : 'Unknown error');
        if (gamePhaseId(this.state) !== command.phaseId) {
          // A later phase failed after this command committed: never invite a replay.
          outcome = { ...pending, status: 'ACCEPTED' };
        } else {
          this.pendingRetreats.delete(power);
          this.pendingBuilds.delete(power);
          outcome = failed('ADJUDICATION_FAILED', 'Resolution failed. Your submission was not finalized; please retry.');
        }
        this.broadcast('game_state_sync', { gameState: this.state });
      }
      if (this.submissionStates.get(power) === pending) this.submissionStates.set(power, outcome);
      return outcome;
    });
    this.submissionReceipts.set(key, { fingerprint, result });
    return result.then(value => structuredClone(value));
  }

  validateOrders(power: Power, orders: Order[]): string | null {
    const seen = new Set<string>();
    for (const order of orders) {
      const unit = this.state.units.find(
        candidate => candidate.territory === order.unitTerritory && !candidate.mustRetreat
      );
      if (!unit || unit.power !== power || order.power !== power) {
        return `Cannot issue an order for ${order.unitTerritory}`;
      }
      if (seen.has(order.unitTerritory)) {
        return `Only one order may be issued for ${order.unitTerritory}`;
      }
      seen.add(order.unitTerritory);
    }
    return null;
  }

  validateAutomatedOrders(power: Power, orders: Order[]): string[] {
    const errors: string[] = [];
    const units = this.state.units.filter(
      unit => unit.power === power && !unit.mustRetreat
    );
    const basicError = this.validateOrders(power, orders);
    if (basicError) errors.push(basicError);
    if (orders.length !== units.length) {
      errors.push(`Exactly ${units.length} orders are required`);
    }

    let legalIds: Set<string>;
    try {
      legalIds = new Set(this.getLegalOrders(power).map(option => option.id));
    } catch (error) {
      errors.push(`Unable to generate authoritative legal orders: ${
        error instanceof Error ? error.message : String(error)
      }`);
      return [...new Set(errors)];
    }
    for (const order of orders) {
      const id = legalOrderId(order);
      if (!legalIds.has(id)) errors.push(`${id} is not a legal order`);
    }
    return [...new Set(errors)];
  }

  validateRetreats(
    power: Power,
    retreats: Record<string, RetreatDestination | null>
  ): string | null {
    const requiredUnits = this.state.units.filter(
      unit => unit.power === power && unit.mustRetreat
    );
    if (Object.keys(retreats).length !== requiredUnits.length) {
      return 'A retreat or disband decision is required for every dislodged unit';
    }
    for (const [unitId, destination] of Object.entries(retreats)) {
      const unit = requiredUnits.find(candidate => candidate.id === unitId);
      if (!unit) return 'Cannot retreat a unit you do not control';
      if (destination !== null && !unit.retreatOptions.includes(destination.territory)) {
        return `${destination.territory} is not a legal retreat for ${unit.territory}`;
      }
      const allowedCoasts = destination ? unit.retreatCoasts[destination.territory] ?? [] : [];
      if (
        destination &&
        (allowedCoasts.length > 0
          ? !destination.coast || !allowedCoasts.includes(destination.coast)
          : destination.coast !== null)
      ) {
        return `A valid coast is required for the retreat to ${destination.territory}`;
      }
    }
    return null;
  }

  validateBuilds(power: Power, payload: SubmitBuildsPayload): string | null {
    const delta = this.computeBuildCounts()[power];
    if (delta >= 0 && payload.disbands.length > 0) {
      return 'Units cannot be disbanded while builds are available';
    }
    if (delta < 0 && payload.disbands.length !== Math.abs(delta)) {
      return `Exactly ${Math.abs(delta)} units must be disbanded`;
    }
    const uniqueDisbands = new Set(payload.disbands);
    if (uniqueDisbands.size !== payload.disbands.length) return 'A unit can only be disbanded once';
    if (payload.disbands.some(id => !this.state.units.some(unit => unit.id === id && unit.power === power))) {
      return 'Cannot disband a unit you do not control';
    }
    if (delta <= 0 && payload.builds.length > 0) return 'No builds are available';
    if (payload.builds.length > Math.max(0, delta)) return `At most ${Math.max(0, delta)} units may be built`;

    const occupied = new Set(this.state.units.map(unit => unit.territory));
    const buildTerritories = new Set<string>();
    for (const build of payload.builds) {
      const territory = TERRITORY_MAP[build.territory];
      const territoryState = this.state.territories[build.territory];
      if (!territory || territory.homePower !== power || territoryState?.owner !== power) {
        return `${build.territory} is not an owned home supply center`;
      }
      if (occupied.has(build.territory) || buildTerritories.has(build.territory)) {
        return `${build.territory} is already occupied or selected for a build`;
      }
      if (build.type === 'FLEET' && territory.type === 'LAND') {
        return `A fleet cannot be built in ${build.territory}`;
      }
      if (build.type === 'FLEET' && territory.coasts.length > 0 && !build.coast) {
        return `A coast is required for a fleet build in ${build.territory}`;
      }
      if (build.type === 'ARMY' && build.coast) {
        return 'Army builds cannot specify a coast';
      }
      if (build.coast && !territory.coasts.includes(build.coast)) {
        return `${build.coast} is not a valid coast for ${build.territory}`;
      }
      buildTerritories.add(build.territory);
    }
    return null;
  }

  async submitRetreats(
    power: Power,
    retreats: Record<string, RetreatDestination | null>
  ): Promise<void> {
    if (this.state.status !== 'IN_PROGRESS') return;
    if (this.state.phase !== 'RETREATS') return;
    this.pendingRetreats.set(power, retreats);

    await this.completeRetreatsPhaseIfReady();
  }

  async submitBuilds(power: Power, payload: SubmitBuildsPayload): Promise<void> {
    if (this.state.status !== 'IN_PROGRESS') return;
    if (this.state.phase !== 'BUILDS') return;
    this.pendingBuilds.set(power, payload);

    await this.completeBuildsPhaseIfReady();
  }

  private async advanceTurn(): Promise<void> {
    const reportYear = this.state.year;
    const reportSeason = this.state.season;
    const before = this.publicBoardSnapshot();
    this.expireOpenOutreachForCurrentPhase();
    const allOrders = Array.from(this.pendingOrders.values()).flat();
    const adjudication = adjudicateWithGodip(this.state, allOrders);
    const result = adjudication.result;

    this.state.lastAdjudicationResult = result;
    this.state.units = adjudication.units;
    this.pendingOrders.clear();
    this.state.submittedPowers = [];
    const hasRetreats = result.dislodgedUnits.length > 0;
    const ownershipChanges = this.state.season === 'FALL' && !hasRetreats
      ? this.updateSupplyCenterOwnership(before)
      : [];
    const after = this.publicBoardSnapshot();
    result.newTerritoryOwnership = Object.fromEntries(
      ownershipChanges.map(change => [change.territory, change.toPower])
    );
    this.recordPhaseReport({
      id: randomUUID(),
      sequence: this.phaseHistory.length + 1,
      year: reportYear,
      season: reportSeason,
      phase: 'ORDERS',
      resolvedAt: new Date().toISOString(),
      before,
      after,
      resolvedOrders: structuredClone(result.resolvedOrders),
      standoffTerritories: [...result.standoffTerritories],
      dislodgedUnits: structuredClone(result.dislodgedUnits),
      destroyedUnits: structuredClone(result.destroyedUnits),
      ownershipChanges,
    });

    if (hasRetreats) {
      this.state.phase = 'RETREATS';
      const allDislodged = this.state.units.filter(u => u.mustRetreat);
      this.broadcast('retreat_phase_start', {
        dislodgedUnits: allDislodged,
        allDislodged,
        gameState: this.state,
      });
      await this.completeRetreatsPhaseIfReady();
    } else {
      await this.advanceSeasonPhase(result);
    }

    this.broadcast('turn_resolved', { adjudicationResult: result, newGameState: this.state });
  }

  private async resolveRetreats(): Promise<void> {
    const before = this.publicBoardSnapshot();
    const submittedRetreats = new Map<string, RetreatDestination | null>();
    const retreatDestinations = new Map<string, string[]>();
    for (const [, retreats] of this.pendingRetreats) {
      for (const [unitId, destination] of Object.entries(retreats)) {
        submittedRetreats.set(unitId, destination);
        const dest = destination?.territory;
        if (dest) {
          if (!retreatDestinations.has(dest)) retreatDestinations.set(dest, []);
          retreatDestinations.get(dest)!.push(unitId);
        }
      }
    }

    const resolutions: RetreatResolution[] = [];
    for (const unit of this.state.units.filter(candidate => candidate.mustRetreat)) {
      const destination = submittedRetreats.get(unit.id) ?? null;
      const conflict = destination
        ? (retreatDestinations.get(destination.territory)?.length ?? 0) > 1
        : false;
      resolutions.push({
        power: unit.power,
        unitId: unit.id,
        unitType: unit.type,
        fromTerritory: unit.territory,
        toTerritory: destination?.territory ?? null,
        toCoast: destination?.coast ?? null,
        outcome: conflict ? 'CONFLICT' : destination ? 'RETREATED' : 'DISBANDED',
      });

      if (!destination || conflict) {
        this.state.units = this.state.units.filter(candidate => candidate.id !== unit.id);
      } else {
        unit.territory = destination.territory;
        unit.coast = destination.coast;
        unit.mustRetreat = false;
        unit.retreatOptions = [];
        unit.retreatCoasts = {};
        unit.dislodgedBy = null;
      }
    }

    this.pendingRetreats.clear();
    const ownershipChanges = this.state.season === 'FALL'
      ? this.updateSupplyCenterOwnership(before)
      : [];
    const adjudicationResult = this.state.lastAdjudicationResult;
    if (adjudicationResult) {
      adjudicationResult.newTerritoryOwnership = Object.fromEntries(
        ownershipChanges.map(change => [change.territory, change.toPower])
      );
    }
    this.recordPhaseReport({
      id: randomUUID(),
      sequence: this.phaseHistory.length + 1,
      year: this.state.year,
      season: this.state.season,
      phase: 'RETREATS',
      resolvedAt: new Date().toISOString(),
      before,
      after: this.publicBoardSnapshot(),
      retreats: resolutions,
      ownershipChanges,
    });
    await this.advanceSeasonPhase(this.state.lastAdjudicationResult!);
  }

  private resolveBuilds(): void {
    const before = this.publicBoardSnapshot();
    const buildCounts = this.computeBuildCounts();
    const adjustments: AdjustmentResolution[] = [];
    for (const [power, payload] of this.pendingBuilds) {
      const disbandedUnits = this.state.units
        .filter(unit => payload.disbands.includes(unit.id))
        .map(unit => structuredClone(unit));
      adjustments.push({
        power,
        builds: structuredClone(payload.builds),
        disbandedUnits,
        waivedBuilds: Math.max(0, buildCounts[power] - payload.builds.length),
      });

      for (const build of payload.builds) {
        const newUnit: Unit = {
          id: randomUUID(),
          type: build.type,
          power,
          territory: build.territory,
          coast: build.coast,
          mustRetreat: false,
          retreatOptions: [],
          retreatCoasts: {},
          dislodgedBy: null,
        };
        this.state.units.push(newUnit);
      }

      for (const unitId of payload.disbands) {
        this.state.units = this.state.units.filter(u => u.id !== unitId);
      }
    }

    this.pendingBuilds.clear();
    this.recordPhaseReport({
      id: randomUUID(),
      sequence: this.phaseHistory.length + 1,
      year: this.state.year,
      season: 'WINTER',
      phase: 'BUILDS',
      resolvedAt: new Date().toISOString(),
      before,
      after: this.publicBoardSnapshot(),
      adjustments,
    });
    this.finishBuildPhase();
  }

  private async advanceSeasonPhase(
    result: NonNullable<GameState['lastAdjudicationResult']>
  ): Promise<void> {
    if (this.state.season === 'SPRING') {
      this.state.season = 'FALL';
      this.state.phase = 'ORDERS';
      this.broadcast('game_state_sync', { gameState: this.state });
      this.scheduleTurnStartPlanning();
      return;
    }

    void result;

    // Check victory (18 supply centers)
    for (const power of ALL_POWERS) {
      const owned = Object.values(this.state.territories).filter(
        t => t.isSupplyCenter && t.owner === power
      ).length;
      if (owned >= 18) {
        this.state.winner = power as Power;
        this.state.status = 'FINISHED';
        this.broadcast('game_over', { winner: power as Power, gameState: this.state });
        return;
      }
    }

    // Compute build counts
    const buildCounts = this.computeBuildCounts();
    if (Object.values(buildCounts).every(count => count === 0)) {
      this.finishBuildPhase();
      return;
    }
    this.state.season = 'WINTER';
    this.state.phase = 'BUILDS';

    this.broadcast('build_phase_start', { buildCounts, gameState: this.state });
    await this.completeBuildsPhaseIfReady();
  }

  private createHoldOrders(power: Power): Order[] {
    return this.state.units
      .filter(unit => unit.power === power)
      .map(unit => ({
        id: randomUUID(),
        power,
        unitTerritory: unit.territory,
        unitCoast: unit.coast as Coast | null,
        type: 'HOLD' as const,
        targetTerritory: null,
        targetCoast: null,
        supportedUnit: null,
        supportedDestination: null,
      }));
  }

  private async completeOrdersPhaseIfReady(): Promise<void> {
    if (this.state.phase !== 'ORDERS' || this.ordersCompletion) {
      await this.ordersCompletion;
      return;
    }
    const activePowers = this.getPowersWithUnits();
    const activeHumans = activePowers.filter(power => this.isHumanPower(power));
    if (!activeHumans.every(power => this.pendingOrders.has(power))) return;

    this.ordersCompletion = (async () => {
      const llmPlayers = this.getLlmPlayers().filter(
        player => activePowers.includes(player.power) && !this.pendingOrders.has(player.power)
      );
      const phaseKey = this.currentOrdersPhaseKey();
      if (this.turnStartPlanning) await this.turnStartPlanning;
      if (!this.turnStartPlanningCompletedFor.has(phaseKey)) {
        await this.runLlmNegotiationRound(llmPlayers);
      }
      await Promise.all(llmPlayers.map(async player => {
        const decision = await this.generatePhaseDecision(
          player,
          'ORDERS',
          (controller, errors) =>
            controller.requestOrders(this.controllerContext(player, true), errors),
          actions => this.validateAutomatedOrders(player.power, actions),
          () => this.createHoldOrders(player.power)
        );
        this.pendingOrders.set(player.power, decision);
        this.markSubmitted(player.power, activePowers.length);
      }));
      if (activePowers.every(power => this.pendingOrders.has(power))) {
        await this.advanceTurn();
      }
    })().finally(() => {
      this.ordersCompletion = null;
    });
    await this.ordersCompletion;
  }

  private async runLlmNegotiationRound(players: LlmPlayer[]): Promise<void> {
    const conversationalPlayers = players.filter(player => player.provider !== 'STUB');
    const configuredInitiators = this.state.settings.llmNegotiationInitiators;
    if (conversationalPlayers.length < 2 || configuredInitiators === 0) return;
    const sortedPlayers = [...conversationalPlayers].sort(
      (left, right) => ALL_POWERS.indexOf(left.power) - ALL_POWERS.indexOf(right.power)
    );
    const seasonOffset = this.state.season === 'FALL' ? 1 : 0;
    const startIndex = (this.state.year * 2 + seasonOffset) % sortedPlayers.length;
    const initiators = Array.from(
      { length: Math.min(configuredInitiators, sortedPlayers.length) },
      (_, index) => sortedPlayers[(startIndex + index) % sortedPlayers.length]
    );

    const initiatives = await Promise.all(initiators.map(async initiator => {
      const eligiblePowers = sortedPlayers
        .map(player => player.power)
        .filter(power => power !== initiator.power);
      const initiative = await this.generateDiplomaticInitiative(
        initiator,
        eligiblePowers
      );
      return { initiator, initiative };
    }));

    await Promise.all(initiatives.map(({ initiator, initiative }) => {
      if (!initiative.toPower) return Promise.resolve();
      return this.runSerializedDiplomacy(
        [initiator.power, initiative.toPower],
        this.state.settings.llmNegotiationMaxMessages,
        0,
        conversationId => this.runAutonomousConversation(
          initiator,
          initiative.toPower!,
          initiative.message,
          initiative.expectsReply,
          conversationId
        )
      );
    }));
  }

  private scheduleTurnStartPlanning(): void {
    if (this.state.status !== 'IN_PROGRESS' || this.state.phase !== 'ORDERS') return;
    const phaseKey = this.currentOrdersPhaseKey();
    if (this.turnStartPlanning || this.turnStartPlanningCompletedFor.has(phaseKey)) return;
    const conversationalPlayers = this.getLlmPlayers()
      .filter(player => player.provider !== 'STUB')
      .filter(player => this.state.units.some(unit => unit.power === player.power && !unit.mustRetreat));
    if (conversationalPlayers.length === 0) {
      this.turnStartPlanningCompletedFor.add(phaseKey);
      return;
    }
    this.turnStartPlanning = this.runTurnStartLlmPlanning(phaseKey, conversationalPlayers)
      .finally(() => {
        if (this.turnStartPlanningCompletedFor.has(phaseKey)) this.turnStartPlanning = null;
      });
  }

  private async runTurnStartLlmPlanning(
    phaseKey: string,
    players: LlmPlayer[]
  ): Promise<void> {
    try {
      const configuredInitiators = this.state.settings.llmNegotiationInitiators;
      if (configuredInitiators === 0) return;
      const sortedPlayers = [...players].sort(
        (left, right) => ALL_POWERS.indexOf(left.power) - ALL_POWERS.indexOf(right.power)
      );
      const seasonOffset = this.state.season === 'FALL' ? 1 : 0;
      const startIndex = (this.state.year * 2 + seasonOffset) % sortedPlayers.length;
      const initiators = Array.from(
        { length: Math.min(configuredInitiators, sortedPlayers.length) },
        (_, index) => sortedPlayers[(startIndex + index) % sortedPlayers.length]
      );

      const initiatives = await Promise.all(initiators.map(async initiator => {
        const eligiblePowers = this.state.players
          .map(player => player.power)
          .filter(power => power !== initiator.power);
        const initiative = await this.generateDiplomaticInitiative(
          initiator,
          eligiblePowers,
          true
        );
        return { initiator, initiative };
      }));

      await Promise.all(initiatives.map(({ initiator, initiative }) => {
        if (!initiative.toPower) return Promise.resolve();
        const recipient = this.state.players.find(player => player.power === initiative.toPower);
        if (recipient?.kind === 'HUMAN') {
          this.deliverTurnStartHumanOutreach(
            initiator.power,
            recipient.power,
            initiative.message
          );
          return Promise.resolve();
        }
        return this.runSerializedDiplomacy(
          [initiator.power, initiative.toPower],
          this.state.settings.llmNegotiationMaxMessages,
          0,
          conversationId => this.runAutonomousConversation(
            initiator,
            initiative.toPower!,
            initiative.message,
            initiative.expectsReply,
            conversationId
          )
        );
      }));
    } catch (error) {
      console.warn(
        `Turn-start LLM planning failed for ${this.gameId}:`,
        error instanceof Error ? error.message : error
      );
    } finally {
      this.turnStartPlanningCompletedFor.add(phaseKey);
    }
  }

  private deliverTurnStartHumanOutreach(
    fromPower: Power,
    toPower: Power,
    body: string
  ): void {
    const message = this.createDiplomaticMessage(fromPower, toPower, body, true);
    this.deliverDiplomaticMessage(message);
    this.llmOutreachRequests.push({
      id: randomUUID(),
      fromPower,
      toPower,
      messageId: message.id,
      year: message.year,
      season: message.season,
      phase: message.phase,
      status: 'OPEN',
      createdAt: message.sentAt,
      resolvedAt: null,
    });
  }

  private async runAutonomousConversation(
    initiator: LlmPlayer,
    recipientPower: Power,
    opening: string,
    expectsReply: boolean,
    conversationId: string
  ): Promise<void> {
    const maxMessages = this.state.settings.llmNegotiationMaxMessages;
    let currentMessage = this.createDiplomaticMessage(
      initiator.power,
      recipientPower,
      opening,
      true
    );
    this.deliverDiplomaticMessage(currentMessage);
    let messageCount = 1;
    this.updateConversationMessageCount(conversationId, messageCount);
    let shouldContinue = expectsReply;

    while (shouldContinue && messageCount < maxMessages) {
      const recipient = this.state.players.find(
        (player): player is LlmPlayer =>
          player.kind === 'LLM' && player.power === currentMessage.toPower
      );
      if (!recipient) return;
      this.updateConversationStatus(conversationId, 'RESPONDING');
      const decision = await this.runSerializedForPower(recipient.power, () =>
        this.generateDiplomaticReply(
          recipient,
          currentMessage,
          {
            messageNumber: messageCount + 1,
            maxMessages,
            warningAtMessages: this.state.settings.llmNegotiationWarningAtMessages,
          },
          true
        )
      );
      const reply = this.createDiplomaticMessage(
        currentMessage.toPower,
        currentMessage.fromPower,
        decision.reply,
        true
      );
      this.deliverDiplomaticMessage(reply);
      currentMessage = reply;
      messageCount++;
      this.updateConversationMessageCount(conversationId, messageCount);
      shouldContinue = decision.expectsReply && messageCount < maxMessages;
    }
  }

  private async generateDiplomaticInitiative(
    player: LlmPlayer,
    eligiblePowers: Power[],
    allowHumanTargets = false
  ): Promise<{ toPower: Power | null; message: string; expectsReply: boolean }> {
    const started = Date.now();
    const plannerModel =
      this.state.settings.llmNegotiationPlannerModel || player.model;
    const model = this.resolveControllerModel(player, 'DIPLOMACY_INITIATIVE', plannerModel);
    const artifact = this.createRunArtifact(
      player,
      'DIPLOMACY',
      'DIPLOMACY_INITIATIVE',
      model
    );
    let errors: string[] = [];

    if (!this.canSpendForLlmRun(artifact)) return { toPower: null, message: '', expectsReply: false };

    for (let attempt = 0; attempt < this.maxLlmAttempts(); attempt++) {
      this.recordRunStatus(artifact, attempt === 0 ? 'THINKING' : 'RETRYING');
      this.broadcastLlmStatus(
        player.power,
        attempt === 0 ? 'THINKING' : 'RETRYING',
        'DIPLOMACY'
      );
      try {
        const decision = await this.controllerFor(
          player,
          'DIPLOMACY_INITIATIVE',
          model
        ).requestDiplomaticInitiative(
          this.controllerContext(player),
          eligiblePowers,
          errors,
          { allowHumanTargets }
        );
        const message = decision.message.trim();
        errors = [];
        if (decision.toPower === null) {
          if (message) errors.push('Message must be empty when no recipient is selected');
        } else {
          if (!eligiblePowers.includes(decision.toPower)) {
            errors.push(`${decision.toPower} is not an eligible LLM recipient`);
          }
          if (!message) errors.push('An initiated diplomatic message cannot be empty');
          if (message.length > 2000) {
            errors.push('An initiated diplomatic message cannot exceed 2000 characters');
          }
        }
        if (errors.length === 0) {
          this.applyControllerMemory(player.power, decision);
          this.completeRunArtifact(artifact, decision, {
            toPower: decision.toPower,
            message,
            expectsReply: decision.expectsReply ?? true,
          });
          this.recordRunUsage(artifact, decision.usage);
          artifact.retryCount = attempt;
          artifact.latencyMs = Date.now() - started;
          this.recordRunStatus(artifact, 'COMPLETE');
          this.recordLlmRunArtifact(artifact);
          this.broadcastLlmStatus(player.power, 'IDLE', 'DIPLOMACY');
          return {
            toPower: decision.toPower,
            message,
            expectsReply: decision.expectsReply ?? true,
          };
        }
      } catch (error) {
        errors = [error instanceof Error ? error.message : String(error)];
      }
    }

    artifact.retryCount = Math.max(0, this.maxLlmAttempts() - 1);
    artifact.validationErrors = errors;
    artifact.fallbackReason = errors.join('; ') || 'Invalid diplomatic initiative';
    artifact.latencyMs = Date.now() - started;
    this.recordRunStatus(artifact, 'FALLBACK');
    this.recordRunStatus(artifact, 'COMPLETE');
    this.recordLlmRunArtifact(artifact);
    this.broadcastLlmStatus(player.power, 'FALLBACK', 'DIPLOMACY');
    this.broadcastLlmStatus(player.power, 'IDLE', 'DIPLOMACY');
    return { toPower: null, message: '', expectsReply: false };
  }

  private async completeRetreatsPhaseIfReady(): Promise<void> {
    if (this.state.phase !== 'RETREATS' || this.retreatsCompletion) {
      await this.retreatsCompletion;
      return;
    }
    const powers = this.getPowersWithDislodgedUnits();
    const humans = powers.filter(power => this.isHumanPower(power));
    if (!humans.every(power => this.pendingRetreats.has(power))) return;

    this.retreatsCompletion = (async () => {
      const llmPlayers = this.getLlmPlayers().filter(
        player => powers.includes(player.power) && !this.pendingRetreats.has(player.power)
      );
      await Promise.all(llmPlayers.map(async player => {
        const actions = await this.generatePhaseDecision(
          player,
          'RETREATS',
          (controller, errors) =>
            controller.requestRetreats(this.controllerContext(player), errors),
          retreats => {
            const error = this.validateRetreats(player.power, retreats);
            return error ? [error] : [];
          },
          () => this.createFallbackRetreats(player.power)
        );
        this.pendingRetreats.set(player.power, actions);
      }));
      if (powers.every(power => this.pendingRetreats.has(power))) {
        await this.resolveRetreats();
      }
    })().finally(() => {
      this.retreatsCompletion = null;
    });
    await this.retreatsCompletion;
  }

  private async completeBuildsPhaseIfReady(): Promise<void> {
    if (this.state.phase !== 'BUILDS' || this.buildsCompletion) {
      await this.buildsCompletion;
      return;
    }
    const powers = this.getPowersNeedingBuildAction();
    const humans = powers.filter(power => this.isHumanPower(power));
    if (!humans.every(power => this.pendingBuilds.has(power))) return;

    this.buildsCompletion = (async () => {
      const llmPlayers = this.getLlmPlayers().filter(
        player => powers.includes(player.power) && !this.pendingBuilds.has(player.power)
      );
      await Promise.all(llmPlayers.map(async player => {
        const actions = await this.generatePhaseDecision(
          player,
          'BUILDS',
          (controller, errors) =>
            controller.requestBuilds(this.controllerContext(player), errors),
          builds => {
            const error = this.validateBuilds(player.power, {
              gameId: this.gameId,
              ...builds,
            });
            return error ? [error] : [];
          },
          () => {
            const fallback = this.createFallbackBuilds(player.power);
            return { builds: fallback.builds, disbands: fallback.disbands };
          }
        );
        this.pendingBuilds.set(player.power, { gameId: this.gameId, ...actions });
      }));
      if (powers.every(power => this.pendingBuilds.has(power))) {
        this.resolveBuilds();
      }
    })().finally(() => {
      this.buildsCompletion = null;
    });
    await this.buildsCompletion;
  }

  private async generatePhaseDecision<T>(
    player: LlmPlayer,
    purpose: 'ORDERS' | 'RETREATS' | 'BUILDS',
    request: (controller: PowerController, errors: string[]) => Promise<ControllerDecision<T>>,
    validate: (actions: T) => string[],
    fallback: () => T
  ): Promise<T> {
    const started = Date.now();
    const modelRole = purpose as LlmModelRole;
    const model = this.resolveControllerModel(player, modelRole);
    const artifact = this.createRunArtifact(player, purpose, modelRole, model);
    let errors: string[] = [];

    if (!this.canSpendForLlmRun(artifact)) return fallback();

    for (let attempt = 0; attempt < this.maxLlmAttempts(); attempt++) {
      this.recordRunStatus(artifact, attempt === 0 ? 'THINKING' : 'RETRYING');
      this.broadcastLlmStatus(player.power, attempt === 0 ? 'THINKING' : 'RETRYING', purpose);
      try {
        const controller = this.controllerFor(player, modelRole, model);
        const decision = await request(controller, errors);
        errors = validate(decision.actions);
        if (errors.length === 0) {
          this.applyControllerMemory(player.power, decision);
          this.completeRunArtifact(artifact, decision, decision.actions);
          this.recordRunUsage(artifact, decision.usage);
          artifact.retryCount = attempt;
          artifact.validationErrors = [];
          artifact.latencyMs = Date.now() - started;
          this.recordRunStatus(artifact, 'COMPLETE');
          this.recordLlmRunArtifact(artifact);
          this.broadcastLlmStatus(player.power, 'IDLE', purpose);
          return decision.actions;
        }
      } catch (error) {
        errors = [error instanceof Error ? error.message : String(error)];
      }
    }

    artifact.retryCount = Math.max(0, this.maxLlmAttempts() - 1);
    artifact.validationErrors = errors;
    artifact.fallbackReason = errors.join('; ') || 'Invalid controller output';
    artifact.latencyMs = Date.now() - started;
    this.recordRunStatus(artifact, 'FALLBACK');
    this.recordRunStatus(artifact, 'COMPLETE');
    this.recordLlmRunArtifact(artifact);
    this.broadcastLlmStatus(player.power, 'FALLBACK', purpose);
    this.broadcastLlmStatus(player.power, 'IDLE', purpose);
    return fallback();
  }

  private async generateDiplomaticReply(
    player: LlmPlayer,
    incomingMessage: DiplomaticMessage,
    conversation?: {
      messageNumber: number;
      maxMessages: number;
      warningAtMessages: number;
    },
    broadcastStatus = false
  ): Promise<{ reply: string; expectsReply: boolean }> {
    const started = Date.now();
    const model = this.resolveControllerModel(player, 'DIPLOMACY_REPLY');
    const artifact = this.createRunArtifact(
      player,
      'DIPLOMACY',
      'DIPLOMACY_REPLY',
      model
    );
    let errors: string[] = [];

    if (!this.canSpendForLlmRun(artifact)) {
      return {
        reply: 'Message received. I will consider this in my next phase decision.',
        expectsReply: false,
      };
    }

    for (let attempt = 0; attempt < this.maxLlmAttempts(); attempt++) {
      const status = attempt === 0 ? 'THINKING' : 'RETRYING';
      this.recordRunStatus(artifact, status);
      if (broadcastStatus) {
        this.broadcastLlmStatus(player.power, status, 'DIPLOMACY');
      } else {
        this.deliverLlmStatus(
          incomingMessage.fromPower,
          player.power,
          status,
          'DIPLOMACY'
        );
      }
      try {
        const decision = await this.controllerFor(
          player,
          'DIPLOMACY_REPLY',
          model
        ).requestDiplomaticReply(
          this.controllerContext(player),
          incomingMessage,
          conversation,
          errors
        );
        const reply = decision.reply.trim();
        errors = !reply
          ? ['Diplomatic reply cannot be empty']
          : reply.length > 2000 ? ['Diplomatic reply cannot exceed 2000 characters'] : [];
        if (errors.length === 0) {
          this.applyControllerMemory(player.power, decision);
          this.completeRunArtifact(artifact, decision, {
            reply,
            expectsReply: decision.expectsReply ?? false,
          });
          this.recordRunUsage(artifact, decision.usage);
          artifact.retryCount = attempt;
          artifact.latencyMs = Date.now() - started;
          this.recordRunStatus(artifact, 'COMPLETE');
          this.recordLlmRunArtifact(artifact);
          if (broadcastStatus) {
            this.broadcastLlmStatus(player.power, 'IDLE', 'DIPLOMACY');
          } else {
            this.deliverLlmStatus(
              incomingMessage.fromPower,
              player.power,
              'IDLE',
              'DIPLOMACY'
            );
          }
          return { reply, expectsReply: decision.expectsReply ?? false };
        }
      } catch (error) {
        errors = [error instanceof Error ? error.message : String(error)];
      }
    }

    artifact.retryCount = Math.max(0, this.maxLlmAttempts() - 1);
    artifact.validationErrors = errors;
    artifact.fallbackReason = errors.join('; ') || 'Invalid diplomatic reply';
    artifact.latencyMs = Date.now() - started;
    this.recordRunStatus(artifact, 'FALLBACK');
    this.recordRunStatus(artifact, 'COMPLETE');
    this.recordLlmRunArtifact(artifact);
    if (broadcastStatus) {
      this.broadcastLlmStatus(player.power, 'FALLBACK', 'DIPLOMACY');
      this.broadcastLlmStatus(player.power, 'IDLE', 'DIPLOMACY');
    } else {
      this.deliverLlmStatus(
        incomingMessage.fromPower,
        player.power,
        'FALLBACK',
        'DIPLOMACY'
      );
      this.deliverLlmStatus(
        incomingMessage.fromPower,
        player.power,
        'IDLE',
        'DIPLOMACY'
      );
    }
    return {
      reply: 'Message received. I will consider this in my next phase decision.',
      expectsReply: false,
    };
  }

  private createFallbackRetreats(
    power: Power
  ): Record<string, RetreatDestination | null> {
    return Object.fromEntries(
      this.state.units
        .filter(unit => unit.power === power && unit.mustRetreat)
        .map(unit => [unit.id, null])
    );
  }

  private createFallbackBuilds(power: Power): SubmitBuildsPayload {
    const counts = this.computeBuildCounts();
    const disbandCount = Math.max(0, -counts[power]);
    return {
      gameId: this.gameId,
      builds: [],
      disbands: this.state.units
        .filter(unit => unit.power === power)
        .slice(0, disbandCount)
        .map(unit => unit.id),
    };
  }

  private resolveControllerModel(
    player: LlmPlayer,
    modelRole: LlmModelRole,
    requestedModel = player.model
  ): string {
    if (!this.enforceLlmPolicy) return requestedModel || player.model;
    return resolveLlmModel({
      policy: this.llmPolicy,
      provider: player.provider,
      requestedModel,
      role: modelRole,
    });
  }

  private maxLlmAttempts(): number {
    return this.enforceLlmPolicy ? this.llmPolicy.maxRetries + 1 : 2;
  }

  private canSpendForLlmRun(artifact: LlmRunArtifact): boolean {
    if (!this.enforceLlmPolicy || artifact.provider === 'STUB') return true;
    if (this.estimatedLlmSpendUsd < this.llmPolicy.maxGameSpendUsd) return true;
    artifact.fallbackReason = `Estimated LLM spend cap reached (${this.llmPolicy.maxGameSpendUsd} USD)`;
    artifact.latencyMs = 0;
    this.recordRunStatus(artifact, 'FALLBACK');
    this.recordRunStatus(artifact, 'COMPLETE');
    this.recordLlmRunArtifact(artifact);
    this.broadcastLlmStatus(artifact.power, 'FALLBACK', artifact.purpose);
    this.broadcastLlmStatus(artifact.power, 'IDLE', artifact.purpose);
    return false;
  }

  private recordRunUsage(
    artifact: LlmRunArtifact,
    usage?: {
      inputTokens: number | null;
      outputTokens: number | null;
    }
  ): void {
    artifact.inputTokens = usage?.inputTokens ?? null;
    artifact.outputTokens = usage?.outputTokens ?? null;
    artifact.estimatedCostUsd = estimateLlmCostUsd({
      provider: artifact.provider,
      model: artifact.model,
      inputTokens: artifact.inputTokens,
      outputTokens: artifact.outputTokens,
    });
    if (artifact.estimatedCostUsd !== null) {
      this.estimatedLlmSpendUsd += artifact.estimatedCostUsd;
    }
  }

  private currentOrdersPhaseKey(): string {
    return `${this.state.year}-${this.state.season}-${this.state.phase}`;
  }

  private markOpenOutreachReplied(fromPower: Power, toPower: Power): void {
    const now = new Date().toISOString();
    let changed = false;
    for (const request of this.llmOutreachRequests) {
      if (
        request.status === 'OPEN' &&
        request.fromPower === toPower &&
        request.toPower === fromPower &&
        request.year === this.state.year &&
        request.season === this.state.season &&
        request.phase === this.state.phase
      ) {
        request.status = 'REPLIED';
        request.resolvedAt = now;
        changed = true;
      }
    }
    if (changed) this.refreshLlmDiplomacyContexts();
  }

  private markOpenOutreachIgnored(power: Power): void {
    const now = new Date().toISOString();
    let changed = false;
    for (const request of this.llmOutreachRequests) {
      if (
        request.status === 'OPEN' &&
        request.toPower === power &&
        request.year === this.state.year &&
        request.season === this.state.season &&
        request.phase === this.state.phase
      ) {
        request.status = 'IGNORED';
        request.resolvedAt = now;
        changed = true;
      }
    }
    if (changed) this.refreshLlmDiplomacyContexts();
  }

  private expireOpenOutreachForCurrentPhase(): void {
    const now = new Date().toISOString();
    let changed = false;
    for (const request of this.llmOutreachRequests) {
      if (
        request.status === 'OPEN' &&
        request.year === this.state.year &&
        request.season === this.state.season &&
        request.phase === this.state.phase
      ) {
        request.status = 'EXPIRED';
        request.resolvedAt = now;
        changed = true;
      }
    }
    if (changed) this.refreshLlmDiplomacyContexts();
  }

  private refreshLlmDiplomacyContexts(): void {
    for (const power of this.llmMemories.keys()) {
      const memory = this.llmMemories.get(power);
      if (!memory) continue;
      memory.diplomaticContext = this.buildPrivateDiplomaticContext(power);
      memory.updatedAt = new Date().toISOString();
      memory.revision++;
    }
  }

  private controllerFor(
    player: LlmPlayer,
    modelRole: LlmModelRole,
    model = this.resolveControllerModel(player, modelRole)
  ): PowerController {
    return this.controllerFactory({
      power: player.power,
      provider: player.provider,
      model,
      modelRole,
      timeoutMs: this.llmPolicy.requestTimeoutMs,
      maxOutputTokens: this.llmPolicy.maxOutputTokens,
    });
  }

  private controllerContext(
    player: LlmPlayer,
    includeLegalOrders = false
  ): ControllerContext {
    const memory = this.llmMemories.get(player.power);
    if (!memory) throw new Error(`Missing LLM memory for ${player.power}`);
    const legalOrders = includeLegalOrders && this.state.phase === 'ORDERS'
      ? this.getLegalOrders(player.power)
      : [];
    return {
      state: this.state,
      power: player.power,
      persona: player.persona,
      messages: this.getDiplomaticMessages(player.power),
      memory: this.getLlmDiplomacyMemory(player.power)!,
      boardContext: buildLlmBoardContext(this.state),
      legalOrders,
      moveSuggestions: includeLegalOrders && this.state.phase === 'ORDERS'
        ? suggestMoveOrderSets(this.state, player.power, legalOrders)
        : [],
    };
  }

  private getLegalOrders(power: Power): LegalOrderOption[] {
    const key = `${this.currentOrdersPhaseKey()}:${power}`;
    const cached = this.legalOrderCache.get(key);
    if (cached) return cached;
    const legalOrders = listLegalOrdersWithGodip(this.state, power);
    this.legalOrderCache.set(key, legalOrders);
    return legalOrders;
  }

  private applyControllerMemory(
    power: Power,
    decision: Pick<ControllerDecision<unknown>, 'strategicSummary' | 'agreements'>
  ): void {
    const memory = this.llmMemories.get(power);
    if (!memory) return;
    memory.strategicSummary = decision.strategicSummary.trim();
    memory.agreements = decision.agreements.map(agreement => ({ ...agreement }));
    memory.updatedAt = new Date().toISOString();
    memory.revision++;
  }

  private createRunArtifact(
    player: LlmPlayer,
    purpose: LlmRunArtifact['purpose'],
    modelRole: LlmModelRole,
    model = this.resolveControllerModel(player, modelRole)
  ): LlmRunArtifact {
    const memory = this.getLlmDiplomacyMemory(player.power);
    if (!memory) throw new Error(`Missing LLM memory for ${player.power}`);
    const messages = this.getDiplomaticMessages(player.power);
    return {
      id: randomUUID(),
      power: player.power,
      year: this.state.year,
      season: this.state.season,
      phase: this.state.phase,
      purpose,
      modelRole,
      provider: player.provider,
      model,
      promptVersion: PROMPT_VERSION,
      boardContextVersion: BOARD_CONTEXT_VERSION,
      legalOrderCount: null,
      selectedLegalOrderIds: [],
      startedAt: new Date().toISOString(),
      latencyMs: 0,
      retryCount: 0,
      fallbackReason: null,
      validationErrors: [],
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      contextMessageIds: messages.map(message => message.id),
      memoryRevisionBefore: memory.revision,
      strategicSummary: null,
      agreementsBefore: structuredClone(memory.agreements),
      agreementsAfter: structuredClone(memory.agreements),
      structuredDecision: null,
      boardSnapshot: this.publicBoardSnapshot(),
      statusHistory: [{
        status: 'QUEUED',
        at: new Date().toISOString(),
      }],
    };
  }

  private completeRunArtifact(
    artifact: LlmRunArtifact,
    decision: Pick<ControllerDecision<unknown>, 'strategicSummary' | 'agreements'>,
    structuredDecision: unknown
  ): void {
    artifact.strategicSummary = decision.strategicSummary.trim();
    artifact.agreementsAfter = structuredClone(decision.agreements);
    artifact.structuredDecision = structuredClone(structuredDecision);
    if (artifact.purpose === 'ORDERS' && Array.isArray(structuredDecision)) {
      const orders = structuredDecision as Order[];
      artifact.selectedLegalOrderIds = orders.map(legalOrderId).sort();
      try {
        artifact.legalOrderCount = this.getLegalOrders(artifact.power).length;
      } catch {
        artifact.legalOrderCount = null;
      }
    }
  }

  private recordRunStatus(
    artifact: LlmRunArtifact,
    status: LlmRunArtifact['statusHistory'][number]['status']
  ): void {
    artifact.statusHistory.push({
      status,
      at: new Date().toISOString(),
    });
  }

  private recordLlmRunArtifact(artifact: LlmRunArtifact): void {
    this.llmRunArtifacts.push(artifact);
    if (!this.io) return;
    const hostSocketId = this.getSocketIdForPlayerId(this.state.hostPlayerId);
    if (!hostSocketId) return;
    const run: LlmRunSummary = {
      id: artifact.id,
      power: artifact.power,
      purpose: artifact.purpose,
      provider: artifact.provider,
      model: artifact.model,
      outcome: artifact.fallbackReason ? 'FALLBACK' : 'COMPLETE',
      latencyMs: artifact.latencyMs,
      retryCount: artifact.retryCount,
      fallbackReason: artifact.fallbackReason,
      validationErrors: [...artifact.validationErrors],
    };
    this.io.to(hostSocketId).emit('llm_telemetry', {
      run,
      counters: this.getLlmFallbackCounters(),
    });
  }

  private broadcastLlmStatus(
    power: Power,
    status: 'IDLE' | 'THINKING' | 'RETRYING' | 'FALLBACK',
    purpose: LlmRunArtifact['purpose']
  ): void {
    if (!this.io) return;
    const hostSocketId = this.getSocketIdForPlayerId(this.state.hostPlayerId);
    if (hostSocketId) {
      this.io.to(hostSocketId).emit('llm_status', { power, status, purpose });
    }
  }

  private deliverLlmStatus(
    viewerPower: Power,
    power: Power,
    status: 'IDLE' | 'THINKING' | 'RETRYING' | 'FALLBACK',
    purpose: LlmRunArtifact['purpose']
  ): void {
    if (!this.io) return;
    const socketId = this.getSocketIdForPower(viewerPower);
    if (socketId) this.io.to(socketId).emit('llm_status', { power, status, purpose });
  }

  private markSubmitted(power: Power, totalRequired: number): void {
    if (!this.state.submittedPowers.includes(power)) {
      this.state.submittedPowers = [...this.state.submittedPowers, power];
    }
    this.broadcast('power_submitted', {
      power,
      totalSubmitted: this.state.submittedPowers.length,
      totalRequired,
    });
  }

  private isHumanPower(power: Power): boolean {
    return this.state.players.some(
      player => player.kind === 'HUMAN' && player.power === power
    );
  }

  private getLlmPlayers(): LlmPlayer[] {
    return this.state.players.filter(
      (player): player is LlmPlayer => player.kind === 'LLM'
    );
  }

  private runSerializedForPower<T>(power: Power, task: () => Promise<T>): Promise<T> {
    const previous = this.llmQueues.get(power) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.voiceLocks.get(power))
      .then(task);
    this.llmQueues.set(power, next);
    void next.finally(() => {
      if (this.llmQueues.get(power) === next) this.llmQueues.delete(power);
    });
    return next;
  }

  private runSerializedDiplomacy<T>(
    participants: [Power, Power],
    maxMessages: number,
    initialMessageCount: number,
    task: (conversationId: string) => Promise<T>
  ): Promise<T> {
    const previous = participants.map(
      power => this.diplomacyParticipantLocks.get(power) ?? Promise.resolve()
    );
    const conversationId = randomUUID();
    const run = Promise.all(previous.map(lock => lock.catch(() => undefined)))
      .then(async () => {
        this.activeConversations.set(conversationId, {
          id: conversationId,
          participants,
          messageCount: initialMessageCount,
          maxMessages,
          status: 'RESPONDING',
        });
        this.broadcastConversationPresence();
        try {
          return await task(conversationId);
        } finally {
          this.activeConversations.delete(conversationId);
          this.broadcastConversationPresence();
        }
      });
    for (const participant of participants) {
      this.diplomacyParticipantLocks.set(participant, run);
    }
    void run.finally(() => {
      for (const participant of participants) {
        if (this.diplomacyParticipantLocks.get(participant) === run) {
          this.diplomacyParticipantLocks.delete(participant);
        }
      }
    });
    return run;
  }

  private updateConversationMessageCount(conversationId: string, messageCount: number): void {
    const conversation = this.activeConversations.get(conversationId);
    if (!conversation) return;
    conversation.messageCount = messageCount;
    conversation.status =
      conversation.maxMessages > 0 && messageCount >= conversation.maxMessages
        ? 'AT_MESSAGE_LIMIT'
        : 'WAITING_FOR_REPLY';
    this.broadcastConversationPresence();
  }

  private updateConversationStatus(
    conversationId: string,
    status: 'WAITING_FOR_REPLY' | 'RESPONDING' | 'AT_MESSAGE_LIMIT'
  ): void {
    const conversation = this.activeConversations.get(conversationId);
    if (!conversation) return;
    conversation.status = status;
    this.broadcastConversationPresence();
  }

  private broadcastConversationPresence(): void {
    if (!this.io) return;
    for (const player of this.state.players) {
      if (player.kind !== 'HUMAN') continue;
      const socketId = this.getSocketIdForPower(player.power);
      if (!socketId) continue;
      const conversations = [...this.activeConversations.values()];
      const conversation = conversations.find(candidate =>
        candidate.participants.includes(player.power)
      ) ?? (
        this.state.settings.publicLlmConversationPresence ? conversations[0] : undefined
      );
      const hasHiddenConversation = conversations.length > 0 && !conversation;
      const visibleParticipants = conversation && (
        this.state.settings.publicLlmConversationPresence ||
        conversation.participants.includes(player.power)
      )
        ? [...conversation.participants] as [Power, Power]
        : null;
      this.io.to(socketId).emit('conversation_presence', {
        active: Boolean(conversation) || hasHiddenConversation,
        status: conversation?.status ?? 'IDLE',
        conversationId: conversation?.id ?? null,
        participants: visibleParticipants,
        messageCount: conversation?.messageCount ?? 0,
        maxMessages: conversation?.maxMessages ?? 0,
      });
    }
  }

  private createDiplomaticMessage(
    fromPower: Power,
    toPower: Power,
    body: string,
    automated: boolean,
    id: string = randomUUID(),
    source: DiplomacyTransportSource = 'WEB',
    externalMessageId: string | null = null
  ): DiplomaticMessage {
    const message: DiplomaticMessage = {
      id,
      gameId: this.gameId,
      fromPower,
      toPower,
      body,
      sentAt: new Date().toISOString(),
      year: this.state.year,
      season: this.state.season,
      phase: this.state.phase,
      automated,
      source,
      externalMessageId,
    };
    this.diplomaticMessages.push(message);
    this.updateLlmDiplomacyMemory(message);
    return message;
  }

  private updateLlmDiplomacyMemory(message: DiplomaticMessage): void {
    for (const power of [message.fromPower, message.toPower]) {
      const player = this.state.players.find(
        (candidate): candidate is LlmPlayer =>
          candidate.power === power && candidate.kind === 'LLM'
      );
      if (!player) continue;

      const memory = this.llmMemories.get(power);
      if (!memory) continue;
      const otherPower = message.fromPower === power ? message.toPower : message.fromPower;
      memory.revision++;
      memory.updatedAt = message.sentAt;
      memory.messageIdsByPower[otherPower] = [
        ...(memory.messageIdsByPower[otherPower] ?? []),
        message.id,
      ];
      memory.diplomaticContext = this.buildPrivateDiplomaticContext(power);
    }
  }

  private buildPrivateDiplomaticContext(power: Power): string {
    const messageLines = this.diplomaticMessages
      .filter(candidate => candidate.fromPower === power || candidate.toPower === power)
      .map(candidate =>
        `[${candidate.year} ${candidate.season} ${candidate.phase}] ` +
        `${candidate.fromPower} -> ${candidate.toPower}: ${candidate.body}`
      );
    const outreachLines = this.llmOutreachRequests
      .filter(request => request.fromPower === power || request.toPower === power)
      .filter(request => request.status !== 'OPEN')
      .map(request =>
        `[${request.year} ${request.season} ${request.phase}] ` +
        `Outreach ${request.fromPower} -> ${request.toPower} was ${request.status.toLowerCase()}.`
      );
    return [...messageLines, ...outreachLines].join('\n');
  }

  private getSocketIdForPower(power: Power): string | null {
    const player = this.state.players.find(
      (candidate): candidate is HumanPlayer =>
        candidate.power === power && candidate.kind === 'HUMAN'
    );
    if (!player) return null;
    return this.getSocketIdForPlayerId(player.id);
  }

  private getSocketIdForPlayerId(playerId: string): string | null {
    return this.playerSessions.get(playerId)?.socketId ?? null;
  }

  private computeBuildCounts(): Record<Power, number> {
    const counts = {} as Record<Power, number>;
    for (const power of ALL_POWERS) {
      const supplyCenterCount = Object.values(this.state.territories).filter(
        t => t.isSupplyCenter && t.owner === power
      ).length;
      const unitCount = this.state.units.filter(u => u.power === power).length;
      counts[power] = supplyCenterCount - unitCount;
    }
    return counts;
  }

  private getPowersWithDislodgedUnits(): Power[] {
    const dislodgedPowers = new Set<Power>();
    for (const unit of this.state.units) {
      if (unit.mustRetreat) dislodgedPowers.add(unit.power);
    }
    return [...dislodgedPowers];
  }

  private getPowersNeedingBuildAction(): Power[] {
    const buildCounts = this.computeBuildCounts();
    return ALL_POWERS.filter(p => buildCounts[p] !== 0);
  }

  private updateSupplyCenterOwnership(
    before: PublicBoardSnapshot
  ): Array<{ territory: TerritoryId; fromPower: Power | null; toPower: Power | null }> {
    for (const unit of this.state.units) {
      if (unit.mustRetreat) continue;
      const territory = this.state.territories[unit.territory];
      if (territory?.isSupplyCenter) territory.owner = unit.power;
    }
    const after = this.publicBoardSnapshot();
    return Object.entries(after.territoryOwners)
      .filter(([territory, owner]) => before.territoryOwners[territory] !== owner)
      .map(([territory, toPower]) => ({
        territory: territory as TerritoryId,
        fromPower: before.territoryOwners[territory],
        toPower,
      }));
  }

  private publicBoardSnapshot(): PublicBoardSnapshot {
    return {
      units: structuredClone(this.state.units),
      territoryOwners: Object.fromEntries(
        Object.entries(this.state.territories).map(([territory, state]) => [
          territory,
          state.owner,
        ])
      ),
    };
  }

  private recordPhaseReport(report: PublicPhaseReport): void {
    const stored = structuredClone(report);
    this.phaseHistory.push(stored);
    this.broadcast('phase_report_added', { report: structuredClone(stored) });
  }

  private getPowersWithUnits(): Power[] {
    return this.state.players
      .map(player => player.power)
      .filter(power => this.state.units.some(unit => unit.power === power && !unit.mustRetreat));
  }

  private finishBuildPhase(): void {
    this.state.year++;
    this.state.season = 'SPRING';
    this.state.phase = 'ORDERS';
    this.broadcast('game_state_sync', { gameState: this.state });
    this.scheduleTurnStartPlanning();
  }

  broadcast<Ev extends keyof ServerToClientEvents>(
    event: Ev,
    data: Parameters<ServerToClientEvents[Ev]>[0]
  ): void {
    if (!this.io) return;
    const room = this.io.to(this.gameId) as unknown as {
      emit: (event: string, payload: unknown) => void;
    };
    room.emit(event as string, data);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const DEFAULT_VOICES: Record<Power, string> = {
  AUSTRIA: 'cedar',
  ENGLAND: 'marin',
  FRANCE: 'coral',
  GERMANY: 'echo',
  ITALY: 'verse',
  RUSSIA: 'ash',
  TURKEY: 'sage',
};

const SUPPORTED_REALTIME_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]);

function normalizeRealtimeVoice(voice: string | undefined, power: Power): string {
  const requested = voice?.trim();
  if (requested && SUPPORTED_REALTIME_VOICES.has(requested)) return requested;
  return DEFAULT_VOICES[power];
}
