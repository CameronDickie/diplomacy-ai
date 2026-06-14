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
  LlmProviderId,
} from '@diplomacy/shared';
import {
  ALL_POWERS,
  TERRITORY_MAP,
  getArmyAdjacency,
  getFleetAdjacency,
} from '@diplomacy/shared';
import { buildInitialTerritories, STARTING_UNITS } from '@diplomacy/shared';
import { adjudicateWithGodip } from './adjudication/GodipAdjudicator.js';
import type {
  ControllerContext,
  ControllerDecision,
  PowerController,
  PowerControllerFactory,
} from './llm/PowerController.js';
import { createPowerController } from './llm/createPowerController.js';
import { PROMPT_VERSION } from './llm/PromptBuilder.js';

export class GameRoom {
  readonly gameId: string;
  private state: GameState;
  private playerSessions = new Map<string, { socketId: string | null; tokenHash: string }>();
  private pendingOrders = new Map<Power, Order[]>();
  private pendingRetreats = new Map<Power, Record<string, RetreatDestination | null>>();
  private pendingBuilds = new Map<Power, SubmitBuildsPayload>();
  private diplomaticMessages: DiplomaticMessage[] = [];
  private llmMemories = new Map<Power, LlmDiplomacyMemory>();
  private llmRunArtifacts: LlmRunArtifact[] = [];
  private llmQueues = new Map<Power, Promise<unknown>>();
  private ordersCompletion: Promise<void> | null = null;
  private retreatsCompletion: Promise<void> | null = null;
  private buildsCompletion: Promise<void> | null = null;
  private io?: Server<ClientToServerEvents, ServerToClientEvents>;
  private readonly controllerFactory: PowerControllerFactory;

  constructor(options: { controllerFactory?: PowerControllerFactory } = {}) {
    this.gameId = randomUUID().slice(0, 8).toUpperCase();
    this.controllerFactory = options.controllerFactory ?? (controllerOptions =>
      createPowerController({
        ...controllerOptions,
        provider: controllerOptions.provider as LlmProviderId,
      })
    );
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
      hostPlayerId: '',
      year: 1901,
      season: 'SPRING',
      phase: 'ORDERS',
      territories: buildInitialTerritories(),
      units,
      players: [],
      settings: {
        llmNegotiationInitiators: 2,
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

  isHost(socketId: string): boolean {
    return this.getPlayerBySocket(socketId)?.id === this.state.hostPlayerId;
  }

  updateLlmNegotiationInitiators(count: number): boolean {
    if (
      this.state.status !== 'LOBBY' ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > ALL_POWERS.length
    ) {
      return false;
    }
    this.state.settings = {
      ...this.state.settings,
      llmNegotiationInitiators: count,
    };
    return true;
  }

  addPlayer(
    socketId: string,
    name: string,
    preferredPower: Power | 'RANDOM' = 'RANDOM'
  ): { player: HumanPlayer; sessionToken: string } | null {
    if (this.state.status !== 'LOBBY') return null;
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
    session.socketId = socketId;
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
  } = {}): Player | null {
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
      model: options.model ?? 'auto-hold-v0',
      persona: options.persona ?? null,
    };
    this.state.players.push(player);
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
    clientMessageId?: string
  ): Promise<DiplomaticMessage[]> {
    const message = this.createDiplomaticMessage(
      fromPower,
      toPower,
      body.trim(),
      false,
      clientMessageId
    );
    const messages = [message];
    this.deliverDiplomaticMessage(message);
    const recipient = this.state.players.find(player => player.power === toPower);

    if (recipient?.kind === 'LLM') {
      const reply = await this.runSerializedForPower(toPower, () =>
        this.generateDiplomaticReply(recipient, message)
      );
      const replyMessage = this.createDiplomaticMessage(toPower, fromPower, reply, true);
      messages.push(replyMessage);
      this.deliverDiplomaticMessage(replyMessage);
    }

    return messages;
  }

  getDiplomaticMessages(power: Power): DiplomaticMessage[] {
    return this.diplomaticMessages
      .filter(message => message.fromPower === power || message.toPower === power)
      .map(message => ({ ...message }));
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
    return this.llmRunArtifacts
      .filter(artifact => !power || artifact.power === power)
      .map(artifact => ({
        ...artifact,
        validationErrors: [...artifact.validationErrors],
      }));
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

  canStart(): boolean {
    return ALL_POWERS.every(power => this.state.players.some(p => p.power === power));
  }

  async startGame(): Promise<boolean> {
    if (this.state.status !== 'LOBBY' || !this.canStart()) return false;
    this.state.status = 'IN_PROGRESS';
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
      throw error;
    }
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

    for (const unit of units) {
      const order = orders.find(candidate => candidate.unitTerritory === unit.territory);
      if (!order) {
        errors.push(`Missing order for ${unit.territory}`);
        continue;
      }
      const adjacency = unit.type === 'ARMY'
        ? getArmyAdjacency(unit.territory)
        : getFleetAdjacency(unit.territory, unit.coast);
      if (order.type === 'MOVE' && (!order.targetTerritory || !adjacency.includes(order.targetTerritory))) {
        errors.push(`${unit.territory} cannot move to ${order.targetTerritory ?? 'null'}`);
      }
      if (order.type === 'HOLD' && (
        order.targetTerritory ||
        order.supportedUnit ||
        order.supportedDestination
      )) {
        errors.push(`Hold order for ${unit.territory} contains unexpected targets`);
      }
      if (
        (order.type === 'SUPPORT_HOLD' || order.type === 'SUPPORT_MOVE') &&
        !order.supportedUnit
      ) {
        errors.push(`Support order for ${unit.territory} requires a supported unit`);
      }
      if (
        order.type === 'SUPPORT_MOVE' &&
        (!order.supportedDestination || !adjacency.includes(order.supportedDestination))
      ) {
        errors.push(`Support from ${unit.territory} cannot reach the supported destination`);
      }
      if (order.type === 'CONVOY' && unit.type !== 'FLEET') {
        errors.push(`Only fleets may convoy from ${unit.territory}`);
      }
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
    if (payload.builds.length > delta) return `At most ${delta} units may be built`;

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
    const allOrders = Array.from(this.pendingOrders.values()).flat();
    const adjudication = adjudicateWithGodip(this.state, allOrders);
    const result = adjudication.result;

    this.state.lastAdjudicationResult = result;
    this.state.units = adjudication.units;
    this.pendingOrders.clear();
    this.state.submittedPowers = [];
    if (this.state.season === 'FALL') this.updateSupplyCenterOwnership();

    if (result.dislodgedUnits.length > 0) {
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
    for (const [, retreats] of this.pendingRetreats) {
      for (const [unitId, destination] of Object.entries(retreats)) {
        const unit = this.state.units.find(u => u.id === unitId);
        if (!unit) continue;

        if (destination === null) {
          // Disband
          this.state.units = this.state.units.filter(u => u.id !== unitId);
        } else {
          unit.territory = destination.territory;
          unit.coast = destination.coast;
          unit.mustRetreat = false;
          unit.retreatOptions = [];
          unit.retreatCoasts = {};
          unit.dislodgedBy = null;
        }
      }
    }

    // Handle conflicting retreats (two units retreat to same province → both disbanded)
    const retreatDestinations = new Map<string, string[]>();
    for (const [, retreats] of this.pendingRetreats) {
      for (const [unitId, destination] of Object.entries(retreats)) {
        const dest = destination?.territory;
        if (dest) {
          if (!retreatDestinations.has(dest)) retreatDestinations.set(dest, []);
          retreatDestinations.get(dest)!.push(unitId);
        }
      }
    }
    for (const [dest, unitIds] of retreatDestinations) {
      if (unitIds.length > 1) {
        // Conflicting retreats all disband.
        this.state.units = this.state.units.filter(u => !unitIds.includes(u.id));
      }
      void dest;
    }

    this.pendingRetreats.clear();
    await this.advanceSeasonPhase(this.state.lastAdjudicationResult!);
  }

  private resolveBuilds(): void {
    for (const [power, payload] of this.pendingBuilds) {
      // Process builds
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

      // Process disbands
      for (const unitId of payload.disbands) {
        this.state.units = this.state.units.filter(u => u.id !== unitId);
      }
    }

    this.pendingBuilds.clear();
    this.finishBuildPhase();
  }

  private async advanceSeasonPhase(
    result: NonNullable<GameState['lastAdjudicationResult']>
  ): Promise<void> {
    if (this.state.season === 'SPRING') {
      this.state.season = 'FALL';
      this.state.phase = 'ORDERS';
      this.broadcast('game_state_sync', { gameState: this.state });
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
      await this.runLlmNegotiationRound(llmPlayers);
      await Promise.all(llmPlayers.map(async player => {
        const decision = await this.generatePhaseDecision(
          player,
          'ORDERS',
          (controller, errors) =>
            controller.requestOrders(this.controllerContext(player), errors),
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

    for (const initiator of initiators) {
      const eligiblePowers = sortedPlayers
        .map(player => player.power)
        .filter(power => power !== initiator.power);
      const initiative = await this.generateDiplomaticInitiative(
        initiator,
        eligiblePowers
      );
      if (!initiative.toPower) continue;
      await this.sendDiplomaticMessage(
        initiator.power,
        initiative.toPower,
        initiative.message
      );
    }
  }

  private async generateDiplomaticInitiative(
    player: LlmPlayer,
    eligiblePowers: Power[]
  ): Promise<{ toPower: Power | null; message: string }> {
    const started = Date.now();
    const artifact = this.createRunArtifact(player, 'DIPLOMACY');
    let errors: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      this.broadcastLlmStatus(
        player.power,
        attempt === 0 ? 'THINKING' : 'RETRYING',
        'DIPLOMACY'
      );
      try {
        const decision = await this.controllerFor(player).requestDiplomaticInitiative(
          this.controllerContext(player),
          eligiblePowers,
          errors
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
          artifact.inputTokens = decision.usage?.inputTokens ?? null;
          artifact.outputTokens = decision.usage?.outputTokens ?? null;
          artifact.retryCount = attempt;
          artifact.latencyMs = Date.now() - started;
          this.llmRunArtifacts.push(artifact);
          this.broadcastLlmStatus(player.power, 'IDLE', 'DIPLOMACY');
          return { toPower: decision.toPower, message };
        }
      } catch (error) {
        errors = [error instanceof Error ? error.message : String(error)];
      }
    }

    artifact.retryCount = 1;
    artifact.validationErrors = errors;
    artifact.fallbackReason = errors.join('; ') || 'Invalid diplomatic initiative';
    artifact.latencyMs = Date.now() - started;
    this.llmRunArtifacts.push(artifact);
    this.broadcastLlmStatus(player.power, 'FALLBACK', 'DIPLOMACY');
    this.broadcastLlmStatus(player.power, 'IDLE', 'DIPLOMACY');
    return { toPower: null, message: '' };
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
    const artifact = this.createRunArtifact(player, purpose);
    let errors: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      this.broadcastLlmStatus(player.power, attempt === 0 ? 'THINKING' : 'RETRYING', purpose);
      try {
        const controller = this.controllerFor(player);
        const decision = await request(controller, errors);
        errors = validate(decision.actions);
        if (errors.length === 0) {
          this.applyControllerMemory(player.power, decision);
          artifact.inputTokens = decision.usage?.inputTokens ?? null;
          artifact.outputTokens = decision.usage?.outputTokens ?? null;
          artifact.retryCount = attempt;
          artifact.validationErrors = [];
          artifact.latencyMs = Date.now() - started;
          this.llmRunArtifacts.push(artifact);
          this.broadcastLlmStatus(player.power, 'IDLE', purpose);
          return decision.actions;
        }
      } catch (error) {
        errors = [error instanceof Error ? error.message : String(error)];
      }
    }

    artifact.retryCount = 1;
    artifact.validationErrors = errors;
    artifact.fallbackReason = errors.join('; ') || 'Invalid controller output';
    artifact.latencyMs = Date.now() - started;
    this.llmRunArtifacts.push(artifact);
    this.broadcastLlmStatus(player.power, 'FALLBACK', purpose);
    this.broadcastLlmStatus(player.power, 'IDLE', purpose);
    return fallback();
  }

  private async generateDiplomaticReply(
    player: LlmPlayer,
    incomingMessage: DiplomaticMessage
  ): Promise<string> {
    const started = Date.now();
    const artifact = this.createRunArtifact(player, 'DIPLOMACY');
    let errors: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      this.deliverLlmStatus(
        incomingMessage.fromPower,
        player.power,
        attempt === 0 ? 'THINKING' : 'RETRYING',
        'DIPLOMACY'
      );
      try {
        const decision = await this.controllerFor(player).requestDiplomaticReply(
          this.controllerContext(player),
          incomingMessage,
          errors
        );
        const reply = decision.reply.trim();
        errors = !reply
          ? ['Diplomatic reply cannot be empty']
          : reply.length > 2000 ? ['Diplomatic reply cannot exceed 2000 characters'] : [];
        if (errors.length === 0) {
          this.applyControllerMemory(player.power, decision);
          artifact.inputTokens = decision.usage?.inputTokens ?? null;
          artifact.outputTokens = decision.usage?.outputTokens ?? null;
          artifact.retryCount = attempt;
          artifact.latencyMs = Date.now() - started;
          this.llmRunArtifacts.push(artifact);
          this.deliverLlmStatus(
            incomingMessage.fromPower,
            player.power,
            'IDLE',
            'DIPLOMACY'
          );
          return reply;
        }
      } catch (error) {
        errors = [error instanceof Error ? error.message : String(error)];
      }
    }

    artifact.retryCount = 1;
    artifact.validationErrors = errors;
    artifact.fallbackReason = errors.join('; ') || 'Invalid diplomatic reply';
    artifact.latencyMs = Date.now() - started;
    this.llmRunArtifacts.push(artifact);
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
    return 'Message received. I will consider this in my next phase decision.';
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

  private controllerFor(player: LlmPlayer): PowerController {
    return this.controllerFactory({
      power: player.power,
      provider: player.provider,
      model: player.model,
    });
  }

  private controllerContext(player: LlmPlayer): ControllerContext {
    const memory = this.llmMemories.get(player.power);
    if (!memory) throw new Error(`Missing LLM memory for ${player.power}`);
    return {
      state: this.state,
      power: player.power,
      persona: player.persona,
      messages: this.getDiplomaticMessages(player.power),
      memory: this.getLlmDiplomacyMemory(player.power)!,
    };
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
    purpose: LlmRunArtifact['purpose']
  ): LlmRunArtifact {
    return {
      id: randomUUID(),
      power: player.power,
      year: this.state.year,
      season: this.state.season,
      phase: this.state.phase,
      purpose,
      provider: player.provider,
      model: player.model,
      promptVersion: PROMPT_VERSION,
      startedAt: new Date().toISOString(),
      latencyMs: 0,
      retryCount: 0,
      fallbackReason: null,
      validationErrors: [],
      inputTokens: null,
      outputTokens: null,
    };
  }

  private broadcastLlmStatus(
    power: Power,
    status: 'IDLE' | 'THINKING' | 'RETRYING' | 'FALLBACK',
    purpose: LlmRunArtifact['purpose']
  ): void {
    this.broadcast('llm_status', { power, status, purpose });
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
    const next = previous.catch(() => undefined).then(task);
    this.llmQueues.set(power, next);
    void next.finally(() => {
      if (this.llmQueues.get(power) === next) this.llmQueues.delete(power);
    });
    return next;
  }

  private createDiplomaticMessage(
    fromPower: Power,
    toPower: Power,
    body: string,
    automated: boolean,
    id: string = randomUUID()
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
      memory.diplomaticContext = this.diplomaticMessages
        .filter(candidate => candidate.fromPower === power || candidate.toPower === power)
        .map(candidate =>
          `[${candidate.year} ${candidate.season} ${candidate.phase}] ` +
          `${candidate.fromPower} -> ${candidate.toPower}: ${candidate.body}`
        )
        .join('\n');
    }
  }

  private getSocketIdForPower(power: Power): string | null {
    const player = this.state.players.find(
      (candidate): candidate is HumanPlayer =>
        candidate.power === power && candidate.kind === 'HUMAN'
    );
    if (!player) return null;
    return this.playerSessions.get(player.id)?.socketId ?? null;
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

  private updateSupplyCenterOwnership(): void {
    for (const unit of this.state.units) {
      if (unit.mustRetreat) continue;
      const territory = this.state.territories[unit.territory];
      if (territory?.isSupplyCenter) territory.owner = unit.power;
    }
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
