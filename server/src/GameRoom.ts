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
} from '@diplomacy/shared';
import { ALL_POWERS, TERRITORY_MAP } from '@diplomacy/shared';
import { buildInitialTerritories, STARTING_UNITS } from '@diplomacy/shared';
import { adjudicateWithGodip } from './adjudication/GodipAdjudicator.js';

export class GameRoom {
  readonly gameId: string;
  private state: GameState;
  private playerSessions = new Map<string, { socketId: string | null; tokenHash: string }>();
  private pendingOrders = new Map<Power, Order[]>();
  private pendingRetreats = new Map<Power, Record<string, RetreatDestination | null>>();
  private pendingBuilds = new Map<Power, SubmitBuildsPayload>();
  private diplomaticMessages: DiplomaticMessage[] = [];
  private llmMemories = new Map<Power, LlmDiplomacyMemory>();
  private io?: Server<ClientToServerEvents, ServerToClientEvents>;

  constructor() {
    this.gameId = randomUUID().slice(0, 8).toUpperCase();
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

  addPlayer(
    socketId: string,
    name: string
  ): { player: HumanPlayer; sessionToken: string } | null {
    if (this.state.status !== 'LOBBY') return null;
    const assignedPowers = new Set(this.state.players.map(p => p.power));
    const available = ALL_POWERS.find(p => !assignedPowers.has(p));
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
    name?: string;
    provider?: 'STUB' | 'OPENAI' | 'ANTHROPIC' | 'OPENROUTER' | 'OLLAMA';
    model?: string;
    persona?: string | null;
  } = {}): Player | null {
    const assignedPowers = new Set(this.state.players.map(p => p.power));
    const available = ALL_POWERS.find(p => !assignedPowers.has(p));
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
    });
    return player;
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

  sendDiplomaticMessage(
    fromPower: Power,
    toPower: Power,
    body: string
  ): DiplomaticMessage[] {
    const message = this.createDiplomaticMessage(fromPower, toPower, body.trim(), false);
    const messages = [message];
    const recipient = this.state.players.find(player => player.power === toPower);

    if (recipient?.kind === 'LLM' && recipient.provider === 'STUB') {
      messages.push(
        this.createDiplomaticMessage(
          toPower,
          fromPower,
          'Message received. This stub player records diplomacy, but strategic negotiation is not connected yet.',
          true
        )
      );
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
    };
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

  startGame(): boolean {
    if (this.state.status !== 'LOBBY' || !this.canStart()) return false;
    this.state.status = 'IN_PROGRESS';
    this.queueAutomatedPhaseActions();
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

  submitOrders(power: Power, orders: Order[]): void {
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

    if (activePowers.every(p => this.state.submittedPowers.includes(p))) {
      try {
        this.advanceTurn();
      } catch (error) {
        this.pendingOrders.delete(power);
        this.state.submittedPowers = this.state.submittedPowers.filter(
          submittedPower => submittedPower !== power
        );
        throw error;
      }
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

  submitRetreats(
    power: Power,
    retreats: Record<string, RetreatDestination | null>
  ): void {
    if (this.state.status !== 'IN_PROGRESS') return;
    if (this.state.phase !== 'RETREATS') return;
    this.pendingRetreats.set(power, retreats);

    const powersWithDislodged = this.getPowersWithDislodgedUnits();
    if (powersWithDislodged.every(p => this.pendingRetreats.has(p))) {
      this.resolveRetreats();
    }
  }

  submitBuilds(power: Power, payload: SubmitBuildsPayload): void {
    if (this.state.status !== 'IN_PROGRESS') return;
    if (this.state.phase !== 'BUILDS') return;
    this.pendingBuilds.set(power, payload);

    const powersNeedingAction = this.getPowersNeedingBuildAction();
    if (powersNeedingAction.every(p => this.pendingBuilds.has(p))) {
      this.resolveBuilds();
    }
  }

  private advanceTurn(): void {
    this.queueAutomatedOrders();

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
      this.queueAutomatedPhaseActions();
    } else {
      this.advanceSeasonPhase(result);
    }

    this.broadcast('turn_resolved', { adjudicationResult: result, newGameState: this.state });
  }

  private resolveRetreats(): void {
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
    this.advanceSeasonPhase(this.state.lastAdjudicationResult!);
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

  private advanceSeasonPhase(result: NonNullable<GameState['lastAdjudicationResult']>): void {
    if (this.state.season === 'SPRING') {
      this.state.season = 'FALL';
      this.state.phase = 'ORDERS';
      this.queueAutomatedPhaseActions();
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
    this.queueAutomatedPhaseActions();
  }

  private queueAutomatedPhaseActions(): void {
    if (this.state.phase === 'ORDERS') {
      this.queueAutomatedOrders();
      const activePowers = this.getPowersWithUnits();
      if (activePowers.length > 0 && activePowers.every(power => this.state.submittedPowers.includes(power))) {
        this.advanceTurn();
      }
    }
    if (this.state.phase === 'RETREATS') {
      this.queueAutomatedRetreats();
      const powersWithDislodged = this.getPowersWithDislodgedUnits();
      if (powersWithDislodged.length > 0 && powersWithDislodged.every(power => this.pendingRetreats.has(power))) {
        this.resolveRetreats();
      }
    }
    if (this.state.phase === 'BUILDS') {
      this.queueAutomatedBuilds();
      const powersNeedingAction = this.getPowersNeedingBuildAction();
      if (powersNeedingAction.length > 0 && powersNeedingAction.every(power => this.pendingBuilds.has(power))) {
        this.resolveBuilds();
      }
    }
  }

  private queueAutomatedOrders(): void {
    for (const player of this.state.players) {
      if (player.kind !== 'LLM' || this.pendingOrders.has(player.power)) continue;
      const holds = this.createHoldOrders(player.power);
      this.pendingOrders.set(player.power, holds);
      if (!this.state.submittedPowers.includes(player.power)) {
        this.state.submittedPowers = [...this.state.submittedPowers, player.power];
      }
    }
  }

  private queueAutomatedRetreats(): void {
    for (const player of this.state.players) {
      if (player.kind !== 'LLM' || this.pendingRetreats.has(player.power)) continue;
      const retreats = Object.fromEntries(
        this.state.units
          .filter(unit => unit.power === player.power && unit.mustRetreat)
          .map(unit => [unit.id, null])
      );
      if (Object.keys(retreats).length > 0) this.pendingRetreats.set(player.power, retreats);
    }
  }

  private queueAutomatedBuilds(): void {
    const counts = this.computeBuildCounts();
    for (const player of this.state.players) {
      if (player.kind !== 'LLM' || this.pendingBuilds.has(player.power)) continue;
      const disbandCount = Math.max(0, -counts[player.power]);
      const disbands = this.state.units
        .filter(unit => unit.power === player.power)
        .slice(0, disbandCount)
        .map(unit => unit.id);
      this.pendingBuilds.set(player.power, {
        gameId: this.gameId,
        builds: [],
        disbands,
      });
    }
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

  private createDiplomaticMessage(
    fromPower: Power,
    toPower: Power,
    body: string,
    automated: boolean
  ): DiplomaticMessage {
    const message: DiplomaticMessage = {
      id: randomUUID(),
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
    this.queueAutomatedPhaseActions();
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
