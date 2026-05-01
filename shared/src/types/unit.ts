import type { Power } from './game.js';
import type { TerritoryId, Coast } from './territory.js';

export type UnitType = 'ARMY' | 'FLEET';

export interface Unit {
  id: string;
  type: UnitType;
  power: Power;
  territory: TerritoryId;
  coast: Coast | null;
  mustRetreat: boolean;
  retreatOptions: TerritoryId[];
  dislodgedBy: TerritoryId | null;
}
