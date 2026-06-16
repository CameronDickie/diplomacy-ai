import type { Power } from './game.js';

export type VoiceSessionStatus =
  | 'IDLE'
  | 'PROVISIONING'
  | 'WAITING_FOR_USER'
  | 'READY'
  | 'LISTENING'
  | 'PROCESSING'
  | 'SPEAKING'
  | 'RECONCILING'
  | 'ENDING'
  | 'FAILED';

export interface DiscordLinkStatus {
  configured: boolean;
  voiceEnabled: boolean;
  guildBound: boolean;
  linked: boolean;
  discordDisplayName: string | null;
  powerBotAvailability: Partial<Record<Power, boolean>>;
}

export interface ExpiringDiscordCode {
  code: string;
  expiresAt: string;
}

export interface VoiceSessionState {
  sessionId: string | null;
  status: VoiceSessionStatus;
  power: Power | null;
  channelId: string | null;
  channelUrl: string | null;
  startedAt: string | null;
  turnCount: number;
  maxTurns: number;
  inputAudioMs: number;
  receivePackets: number;
  outputAudioMs: number;
  debug: string[];
  error: string | null;
}
