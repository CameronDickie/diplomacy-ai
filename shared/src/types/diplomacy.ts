import type { Phase, Power, Season } from './game.js';
import type { DiplomaticAgreement } from './llm.js';

export type DiplomacyTransportSource =
  | 'WEB'
  | 'DISCORD_TEXT'
  | 'DISCORD_VOICE';

export interface DiplomaticMessage {
  id: string;
  gameId: string;
  fromPower: Power;
  toPower: Power;
  body: string;
  sentAt: string;
  year: number;
  season: Season;
  phase: Phase;
  automated: boolean;
  source: DiplomacyTransportSource;
  externalMessageId: string | null;
}

export interface LlmDiplomacyMemory {
  power: Power;
  revision: number;
  updatedAt: string | null;
  messageIdsByPower: Partial<Record<Power, string[]>>;
  diplomaticContext: string;
  strategicSummary: string;
  agreements: DiplomaticAgreement[];
}
