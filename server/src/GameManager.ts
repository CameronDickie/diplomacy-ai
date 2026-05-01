import { GameRoom } from './GameRoom.js';

export class GameManager {
  private rooms = new Map<string, GameRoom>();

  createGame(creatorSocketId: string, playerName: string): GameRoom {
    const room = new GameRoom();
    this.rooms.set(room.gameId, room);
    room.addPlayer(creatorSocketId, playerName);
    return room;
  }

  getRoom(gameId: string): GameRoom | undefined {
    return this.rooms.get(gameId);
  }

  getRoomBySocket(socketId: string): GameRoom | undefined {
    for (const room of this.rooms.values()) {
      if (room.hasSocket(socketId)) return room;
    }
    return undefined;
  }

  removeRoom(gameId: string): void {
    this.rooms.delete(gameId);
  }
}
