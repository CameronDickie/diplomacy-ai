import type { Power } from '../types/game.js';
import type { TerritoryId, TerritoryState } from '../types/territory.js';
import type { Unit } from '../types/unit.js';
import { HOME_SUPPLY_CENTERS, TERRITORIES } from './territories.js';

/** Starting unit definitions (before UUIDs are assigned) */
export const STARTING_UNITS: Omit<Unit, 'id' | 'mustRetreat' | 'retreatOptions' | 'dislodgedBy'>[] = [
  // AUSTRIA
  { type: 'ARMY',  power: 'AUSTRIA', territory: 'BUD', coast: null },
  { type: 'ARMY',  power: 'AUSTRIA', territory: 'VIE', coast: null },
  { type: 'FLEET', power: 'AUSTRIA', territory: 'TRI', coast: null },
  // ENGLAND
  { type: 'FLEET', power: 'ENGLAND', territory: 'EDI', coast: null },
  { type: 'FLEET', power: 'ENGLAND', territory: 'LON', coast: null },
  { type: 'ARMY',  power: 'ENGLAND', territory: 'LVP', coast: null },
  // FRANCE
  { type: 'ARMY',  power: 'FRANCE',  territory: 'PAR', coast: null },
  { type: 'ARMY',  power: 'FRANCE',  territory: 'MAR', coast: null },
  { type: 'FLEET', power: 'FRANCE',  territory: 'BRE', coast: null },
  // GERMANY
  { type: 'ARMY',  power: 'GERMANY', territory: 'BER', coast: null },
  { type: 'ARMY',  power: 'GERMANY', territory: 'MUN', coast: null },
  { type: 'FLEET', power: 'GERMANY', territory: 'KIE', coast: null },
  // ITALY
  { type: 'ARMY',  power: 'ITALY',   territory: 'ROM', coast: null },
  { type: 'ARMY',  power: 'ITALY',   territory: 'VEN', coast: null },
  { type: 'FLEET', power: 'ITALY',   territory: 'NAP', coast: null },
  // RUSSIA
  { type: 'ARMY',  power: 'RUSSIA',  territory: 'MOS', coast: null },
  { type: 'ARMY',  power: 'RUSSIA',  territory: 'WAR', coast: null },
  { type: 'FLEET', power: 'RUSSIA',  territory: 'SEV', coast: null },
  { type: 'FLEET', power: 'RUSSIA',  territory: 'STP', coast: 'SOUTH' },
  // TURKEY
  { type: 'ARMY',  power: 'TURKEY',  territory: 'CON', coast: null },
  { type: 'ARMY',  power: 'TURKEY',  territory: 'SMY', coast: null },
  { type: 'FLEET', power: 'TURKEY',  territory: 'ANK', coast: null },
];

/** Initial territory ownership (home supply centers only, all others null) */
export function buildInitialTerritories(): Record<TerritoryId, TerritoryState> {
  const result: Record<TerritoryId, TerritoryState> = {};

  // Build a reverse map: territory → home power
  const homePowerOf: Record<string, Power> = {};
  for (const [power, centers] of Object.entries(HOME_SUPPLY_CENTERS)) {
    for (const center of centers) {
      homePowerOf[center] = power as Power;
    }
  }

  for (const territory of TERRITORIES) {
    result[territory.id] = {
      id: territory.id,
      isSupplyCenter: territory.isSupplyCenter,
      owner: homePowerOf[territory.id] ?? null,
    };
  }

  return result;
}
