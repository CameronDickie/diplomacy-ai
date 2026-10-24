import { GameRoom } from './GameRoom.js';

/** How many rooms the server holds in memory, and how many unfinished rooms one account may host. */
export interface RoomLimits { maxRooms: number; maxRoomsPerAccount: number }

export class GameManager {
  private rooms = new Map<string, GameRoom>();
  /** The signed-in account that created each room, where there was one. */
  private owners = new Map<string, string>();

  constructor(
    private readonly roomOptions: ConstructorParameters<typeof GameRoom>[0] = {},
    private readonly limits: RoomLimits = { maxRooms: Infinity, maxRoomsPerAccount: Infinity },
  ) {}

  /**
   * Why a new room cannot be created now, or null. Finished rooms and rooms nobody is connected to are
   * given up first: an account's own when it is at its limit, any when the server is full. `perAccount`
   * applies the account limit (the showcase profile); the total always applies.
   */
  refusal(owner: string | null, perAccount: boolean): 'SERVER_FULL' | 'HOSTING_LIMIT' | null {
    if (perAccount && owner !== null) {
      const hosted = () => this.getRooms().filter(room => this.owners.get(room.gameId) === owner);
      if (hosted().length >= this.limits.maxRoomsPerAccount) hosted().filter(room => this.reclaimable(room)).forEach(room => this.removeRoom(room.gameId));
      if (hosted().length >= this.limits.maxRoomsPerAccount) return 'HOSTING_LIMIT';
    }
    if (this.rooms.size >= this.limits.maxRooms) this.getRooms().filter(room => this.reclaimable(room)).forEach(room => this.removeRoom(room.gameId));
    return this.rooms.size >= this.limits.maxRooms ? 'SERVER_FULL' : null;
  }

  createGame(owner: string | null = null): GameRoom {
    const room = new GameRoom(this.roomOptions);
    this.rooms.set(room.gameId, room);
    if (owner !== null) this.owners.set(room.gameId, owner);
    return room;
  }

  getRoom(gameId: string): GameRoom | undefined {
    return this.rooms.get(gameId);
  }

  getRooms(): GameRoom[] {
    return [...this.rooms.values()];
  }

  getRoomBySocket(socketId: string): GameRoom | undefined {
    for (const room of this.rooms.values()) {
      if (room.hasSocket(socketId)) return room;
    }
    return undefined;
  }

  removeRoom(gameId: string): void {
    this.rooms.get(gameId)?.dispose();
    this.rooms.delete(gameId);
    this.owners.delete(gameId);
  }

  dispose(): void {
    for (const gameId of [...this.rooms.keys()]) this.removeRoom(gameId);
  }

  private reclaimable(room: GameRoom): boolean {
    const state = room.getState();
    return state.status === 'FINISHED' || !state.players.some(player => player.kind === 'HUMAN' && player.connected);
  }
}
