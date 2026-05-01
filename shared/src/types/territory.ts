import type { Power } from './game.js';

export type TerritoryId = string;

export type TerritoryType = 'LAND' | 'SEA' | 'COASTAL';

export type Coast = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';

export interface Territory {
  id: TerritoryId;
  name: string;
  type: TerritoryType;
  isSupplyCenter: boolean;
  homePower: Power | null;
  coasts: Coast[];
}

export interface TerritoryState {
  id: TerritoryId;
  owner: Power | null;
  isSupplyCenter: boolean;
}
