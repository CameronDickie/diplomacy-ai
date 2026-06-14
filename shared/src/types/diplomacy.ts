import type { Phase, Power, Season } from './game.js';

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
}

export interface LlmDiplomacyMemory {
  power: Power;
  revision: number;
  updatedAt: string | null;
  messageIdsByPower: Partial<Record<Power, string[]>>;
  diplomaticContext: string;
}
