import { randomUUID } from 'crypto';
import type { Server, Socket } from 'socket.io';
import type {
  Power,
  GameState,
  Player,
  Order,
  Unit,
  ClientToServerEvents,
  ServerToClientEvents,
  SubmitRetreatsPayload,
  SubmitBuildsPayload,
} from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import { buildInitialTerritories, STARTING_UNITS } from '@diplomacy/shared';
import { adjudicate } from './adjudication/index.js';

export class GameRoom {
  readonly gameId: string;
  private state: GameState;
  private pendingOrders = new Map<Power, Order[]>();
  private pendingRetreats = new Map<Power, Record<string, string | null>>();
  private pendingBuilds = new Map<Power, SubmitBuildsPayload>();
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
      dislodgedBy: null,
    }));

    return {
      gameId: this.gameId,
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
    return this.state.players.some(p => p.socketId === socketId);
  }

  getPlayerBySocket(socketId: string): Player | undefined {
    return this.state.players.find(p => p.socketId === socketId);
  }

  addPlayer(socketId: string, name: string): Player | null {
    const assignedPowers = new Set(this.state.players.map(p => p.power));
    const available = ALL_POWERS.find(p => !assignedPowers.has(p));
    if (!available) return null;

    const player: Player = { socketId, name, power: available, connected: true };
    this.state.players.push(player);

    if (this.state.players.length === ALL_POWERS.length) {
      this.state.status = 'IN_PROGRESS';
    }

    return player;
  }

  markDisconnected(socketId: string): void {
    const player = this.getPlayerBySocket(socketId);
    if (player) player.connected = false;
  }

  markReconnected(socketId: string, newSocketId: string): void {
    const player = this.state.players.find(p => p.socketId === socketId);
    if (player) {
      player.socketId = newSocketId;
      player.connected = true;
    }
  }

  submitOrders(power: Power, orders: Order[]): void {
    if (this.state.phase !== 'ORDERS') return;
    if (this.state.submittedPowers.includes(power)) return;

    this.pendingOrders.set(power, orders);
    this.state.submittedPowers = [...this.state.submittedPowers, power];

    const activePowers = this.state.players.map(p => p.power);

    this.broadcast('power_submitted', {
      power,
      totalSubmitted: this.state.submittedPowers.length,
      totalRequired: activePowers.length,
    });

    if (activePowers.every(p => this.state.submittedPowers.includes(p))) {
      this.advanceTurn();
    }
  }

  submitRetreats(power: Power, retreats: Record<string, string | null>): void {
    if (this.state.phase !== 'RETREATS') return;
    this.pendingRetreats.set(power, retreats);

    const powersWithDislodged = this.getPowersWithDislodgedUnits();
    if (powersWithDislodged.every(p => this.pendingRetreats.has(p))) {
      this.resolveRetreats();
    }
  }

  submitBuilds(power: Power, payload: SubmitBuildsPayload): void {
    if (this.state.phase !== 'BUILDS') return;
    this.pendingBuilds.set(power, payload);

    const powersNeedingAction = this.getPowersNeedingBuildAction();
    if (powersNeedingAction.every(p => this.pendingBuilds.has(p))) {
      this.resolveBuilds();
    }
  }

  private advanceTurn(): void {
    // Fill in HOLDs for any powers that didn't submit
    for (const player of this.state.players) {
      if (!this.pendingOrders.has(player.power)) {
        const holds: Order[] = this.state.units
          .filter(u => u.power === player.power)
          .map(u => ({
            id: randomUUID(),
            power: player.power,
            unitTerritory: u.territory,
            unitCoast: u.coast,
            type: 'HOLD' as const,
            targetTerritory: null,
            targetCoast: null,
            supportedUnit: null,
            supportedDestination: null,
          }));
        this.pendingOrders.set(player.power, holds);
      }
    }

    const allOrders = Array.from(this.pendingOrders.values()).flat();
    const result = adjudicate(this.state, allOrders);

    this.state.lastAdjudicationResult = result;
    this.pendingOrders.clear();
    this.state.submittedPowers = [];

    // Apply successful moves
    for (const resolved of result.resolvedOrders) {
      if (resolved.type === 'MOVE' && resolved.resolution === 'SUCCEEDS') {
        const unit = this.state.units.find(u => u.territory === resolved.unitTerritory);
        if (unit) {
          unit.territory = resolved.targetTerritory!;
          unit.coast = resolved.targetCoast;
        }
      }
    }

    // Mark dislodged units
    for (const dislodged of result.dislodgedUnits) {
      const unit = this.state.units.find(u => u.id === dislodged.id);
      if (unit) {
        unit.mustRetreat = true;
        unit.retreatOptions = dislodged.retreatOptions;
        unit.dislodgedBy = dislodged.dislodgedBy;
      }
    }

    // Remove destroyed units (no retreat options)
    for (const destroyed of result.destroyedUnits) {
      this.state.units = this.state.units.filter(u => u.id !== destroyed.id);
    }

    if (result.dislodgedUnits.length > 0) {
      this.state.phase = 'RETREATS';
      const allDislodged = this.state.units.filter(u => u.mustRetreat);
      this.broadcast('retreat_phase_start', {
        dislodgedUnits: allDislodged,
        allDislodged,
        gameState: this.state,
      });
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
          unit.territory = destination;
          unit.mustRetreat = false;
          unit.retreatOptions = [];
          unit.dislodgedBy = null;
          unit.coast = null; // TODO: handle coast for SPA/STP/BUL retreats
        }
      }
    }

    // Handle conflicting retreats (two units retreat to same province → both disbanded)
    const retreatDestinations = new Map<string, string[]>();
    for (const [, retreats] of this.pendingRetreats) {
      for (const [unitId, dest] of Object.entries(retreats)) {
        if (dest) {
          if (!retreatDestinations.has(dest)) retreatDestinations.set(dest, []);
          retreatDestinations.get(dest)!.push(unitId);
        }
      }
    }
    for (const [dest, unitIds] of retreatDestinations) {
      if (unitIds.length > 1) {
        // Both disbandedast
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
    this.state.year++;
    this.state.season = 'SPRING';
    this.state.phase = 'ORDERS';
    this.broadcast('game_state_sync', { gameState: this.state });
  }

  private advanceSeasonPhase(result: NonNullable<GameState['lastAdjudicationResult']>): void {
    if (this.state.season === 'SPRING') {
      this.state.season = 'FALL';
      this.state.phase = 'ORDERS';
      this.broadcast('game_state_sync', { gameState: this.state });
      return;
    }

    // FALL → transfer supply center ownership
    for (const unit of this.state.units) {
      const territory = this.state.territories[unit.territory];
      if (territory?.isSupplyCenter) {
        territory.owner = unit.power;
      }
    }

    // Check victory (18 supply centers)
    for (const [power] of Object.entries(result.buildCounts)) {
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
    this.state.season = 'WINTER';
    this.state.phase = 'BUILDS';

    this.broadcast('build_phase_start', { buildCounts, gameState: this.state });
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

  broadcast<Ev extends keyof ServerToClientEvents>(
    event: Ev,
    data: Parameters<ServerToClientEvents[Ev]>[0]
  ): void {
    if (!this.io) return;
    // Emit to all sockets in the game room
    for (const player of this.state.players) {
      if (player.connected) {
        this.io.to(player.socketId).emit(event as string, data as never);
      }
    }
  }
}
