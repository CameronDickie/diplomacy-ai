import { randomBytes } from 'crypto';
import type {
  DiscordLinkStatus,
  ExpiringDiscordCode,
  HumanPlayer,
  Power,
} from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import type { GameManager } from '../GameManager.js';

interface PendingCode {
  gameId: string;
  playerId: string;
  expiresAt: number;
}

interface DiscordPlayerLink {
  gameId: string;
  playerId: string;
  discordUserId: string;
  displayName: string;
}

const CODE_TTL_MS = 10 * 60 * 1000;

export class DiscordLinkService {
  private guildBindCodes = new Map<string, PendingCode>();
  private playerLinkCodes = new Map<string, PendingCode>();
  private playerLinksByDiscordId = new Map<string, DiscordPlayerLink>();
  private playerLinksByPlayerId = new Map<string, DiscordPlayerLink>();
  private boundGameId: string | null = null;

  constructor(
    private readonly gameManager: GameManager,
    readonly configuredGuildId: string | null,
    private readonly configuredPowerBots: ReadonlySet<Power> = new Set(ALL_POWERS),
    private readonly voiceEnabled = false
  ) {}

  createGuildBindCode(gameId: string, host: HumanPlayer): ExpiringDiscordCode {
    const room = this.requireRoom(gameId);
    if (room.getState().hostPlayerId !== host.id) {
      throw new Error('Only the host can bind Discord');
    }
    return this.createCode(this.guildBindCodes, room.gameId, host.id);
  }

  createPlayerLinkCode(gameId: string, player: HumanPlayer): ExpiringDiscordCode {
    const room = this.requireRoom(gameId);
    return this.createCode(this.playerLinkCodes, room.gameId, player.id);
  }

  bindGuild(code: string, guildId: string): string {
    if (!this.configuredGuildId) throw new Error('Discord is not configured');
    if (guildId !== this.configuredGuildId) {
      throw new Error('This bot deployment is configured for another Discord server');
    }
    const pending = this.consumeCode(this.guildBindCodes, code);
    this.boundGameId = pending.gameId;
    return pending.gameId;
  }

  linkPlayer(
    code: string,
    discordUserId: string,
    displayName: string
  ): DiscordPlayerLink {
    const pending = this.consumeCode(this.playerLinkCodes, code);
    if (this.boundGameId !== pending.gameId) {
      throw new Error('Bind the game to this Discord server before linking players');
    }
    const room = this.requireRoom(pending.gameId);
    const player = room.getPlayerById(pending.playerId);
    if (!player) throw new Error('The player no longer exists');

    this.unlinkDiscordUser(discordUserId);
    const previous = this.playerLinksByPlayerId.get(player.id);
    if (previous) this.unlinkDiscordUser(previous.discordUserId);

    const link = {
      gameId: room.gameId,
      playerId: player.id,
      discordUserId,
      displayName,
    };
    this.playerLinksByDiscordId.set(discordUserId, link);
    this.playerLinksByPlayerId.set(player.id, link);
    return link;
  }

  unlinkDiscordUser(discordUserId: string): boolean {
    const link = this.playerLinksByDiscordId.get(discordUserId);
    if (!link) return false;
    this.playerLinksByDiscordId.delete(discordUserId);
    this.playerLinksByPlayerId.delete(link.playerId);
    return true;
  }

  resolveDiscordUser(discordUserId: string): {
    gameId: string;
    player: HumanPlayer;
  } | null {
    const link = this.playerLinksByDiscordId.get(discordUserId);
    if (!link || link.gameId !== this.boundGameId) return null;
    const room = this.gameManager.getRoom(link.gameId);
    const player = room?.getPlayerById(link.playerId);
    return room && player ? { gameId: room.gameId, player } : null;
  }

  getDiscordUserId(playerId: string): string | null {
    return this.playerLinksByPlayerId.get(playerId)?.discordUserId ?? null;
  }

  getBoundGameId(): string | null {
    return this.boundGameId;
  }

  getStatus(gameId: string, playerId: string): DiscordLinkStatus {
    const room = this.gameManager.getRoom(gameId);
    const link = this.playerLinksByPlayerId.get(playerId);
    const powerBotAvailability = Object.fromEntries(
      (room?.getState().players ?? [])
        .filter(
          player =>
            player.kind === 'LLM' && this.configuredPowerBots.has(player.power)
        )
        .map(player => [player.power, true])
    ) as Partial<Record<Power, boolean>>;
    return {
      configured: Boolean(this.configuredGuildId),
      voiceEnabled: this.voiceEnabled,
      guildBound: this.boundGameId === gameId,
      linked: link?.gameId === gameId,
      discordDisplayName: link?.gameId === gameId ? link.displayName : null,
      powerBotAvailability,
    };
  }

  private createCode(
    store: Map<string, PendingCode>,
    gameId: string,
    playerId: string
  ): ExpiringDiscordCode {
    this.pruneExpiredCodes();
    const code = randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = Date.now() + CODE_TTL_MS;
    store.set(code, { gameId, playerId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  private consumeCode(store: Map<string, PendingCode>, rawCode: string): PendingCode {
    this.pruneExpiredCodes();
    const code = rawCode.trim().toUpperCase();
    const pending = store.get(code);
    if (!pending) throw new Error('The code is invalid or expired');
    store.delete(code);
    return pending;
  }

  private pruneExpiredCodes(): void {
    const now = Date.now();
    for (const store of [this.guildBindCodes, this.playerLinkCodes]) {
      for (const [code, pending] of store) {
        if (pending.expiresAt <= now) store.delete(code);
      }
    }
  }

  private requireRoom(gameId: string) {
    const room = this.gameManager.getRoom(gameId.trim().toUpperCase());
    if (!room) throw new Error('Game not found');
    return room;
  }
}
