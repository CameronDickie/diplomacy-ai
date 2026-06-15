import { randomUUID } from 'crypto';
import type {
  DiplomacyTransportSource,
  DiplomaticMessage,
  Power,
} from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';

export interface SendDiplomacyRequest {
  gameId: string;
  fromPower: Power;
  toPower: Power;
  body: string;
  source: DiplomacyTransportSource;
  messageId?: string;
  externalMessageId?: string | null;
}

export class DiplomacyService {
  private externalMessageIds = new Set<string>();

  constructor(private readonly gameManager: GameManager) {}

  async send(request: SendDiplomacyRequest): Promise<DiplomaticMessage[]> {
    const room = this.gameManager.getRoom(request.gameId.trim().toUpperCase());
    if (!room) throw new DiplomacyError('GAME_NOT_FOUND', 'Game not found');

    const validationError = room.validateDiplomaticMessage(
      request.fromPower,
      request.toPower,
      request.body
    );
    if (validationError) {
      throw new DiplomacyError('INVALID_MESSAGE', validationError);
    }

    const deduplicationKey = request.externalMessageId
      ? `${request.source}:${request.externalMessageId}`
      : null;
    if (deduplicationKey && this.externalMessageIds.has(deduplicationKey)) {
      return [];
    }
    if (deduplicationKey) this.externalMessageIds.add(deduplicationKey);

    try {
      return await room.sendDiplomaticMessage(
        request.fromPower,
        request.toPower,
        request.body,
        request.messageId ?? randomUUID(),
        request.source,
        request.externalMessageId ?? null
      );
    } catch (error) {
      if (deduplicationKey) this.externalMessageIds.delete(deduplicationKey);
      throw error;
    }
  }
}

export class DiplomacyError extends Error {
  constructor(
    readonly code: 'GAME_NOT_FOUND' | 'INVALID_MESSAGE',
    message: string
  ) {
    super(message);
  }
}
