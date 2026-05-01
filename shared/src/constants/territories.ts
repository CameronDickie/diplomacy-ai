import type { Territory } from '../types/territory.js';

/**
 * All 75 standard Diplomacy territories.
 * type: LAND = inland (armies only), SEA = sea zone (fleets only), COASTAL = both
 */
export const TERRITORIES: Territory[] = [
  // ── Sea Zones ─────────────────────────────────────────────────────────────
  { id: 'ADR', name: 'Adriatic Sea',          type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'AEG', name: 'Aegean Sea',            type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'BAL', name: 'Baltic Sea',            type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'BAR', name: 'Barents Sea',           type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'BLA', name: 'Black Sea',             type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'BOT', name: 'Gulf of Bothnia',       type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'EAS', name: 'Eastern Mediterranean', type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'ENG', name: 'English Channel',       type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'GOL', name: 'Gulf of Lyon',          type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'HEL', name: 'Heligoland Bight',      type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'ION', name: 'Ionian Sea',            type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'IRI', name: 'Irish Sea',             type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'MAO', name: 'Mid-Atlantic Ocean',    type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'NAO', name: 'North Atlantic Ocean',  type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'NTH', name: 'North Sea',             type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'NWG', name: 'Norwegian Sea',         type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'SKA', name: 'Skagerrak',             type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'TYS', name: 'Tyrrhenian Sea',        type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },
  { id: 'WES', name: 'Western Mediterranean', type: 'SEA',     isSupplyCenter: false, homePower: null, coasts: [] },

  // ── Inland (LAND) territories ─────────────────────────────────────────────
  { id: 'BOH', name: 'Bohemia',   type: 'LAND', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'BUD', name: 'Budapest',  type: 'LAND', isSupplyCenter: true,  homePower: 'AUSTRIA', coasts: [] },
  { id: 'BUR', name: 'Burgundy',  type: 'LAND', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'GAL', name: 'Galicia',   type: 'LAND', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'MOS', name: 'Moscow',    type: 'LAND', isSupplyCenter: true,  homePower: 'RUSSIA',  coasts: [] },
  { id: 'MUN', name: 'Munich',    type: 'LAND', isSupplyCenter: true,  homePower: 'GERMANY', coasts: [] },
  { id: 'PAR', name: 'Paris',     type: 'LAND', isSupplyCenter: true,  homePower: 'FRANCE',  coasts: [] },
  { id: 'PRU', name: 'Prussia',   type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'RUH', name: 'Ruhrgebiet',type: 'LAND', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'SIL', name: 'Silesia',   type: 'LAND', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'TYR', name: 'Tyrolia',   type: 'LAND', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'UKR', name: 'Ukraine',   type: 'LAND', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'VIE', name: 'Vienna',    type: 'LAND', isSupplyCenter: true,  homePower: 'AUSTRIA', coasts: [] },
  { id: 'WAR', name: 'Warsaw',    type: 'LAND', isSupplyCenter: true,  homePower: 'RUSSIA',  coasts: [] },

  // ── Coastal territories ───────────────────────────────────────────────────
  { id: 'ALB', name: 'Albania',         type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'ANK', name: 'Ankara',          type: 'COASTAL', isSupplyCenter: true,  homePower: 'TURKEY',  coasts: [] },
  { id: 'APU', name: 'Apulia',          type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'ARM', name: 'Armenia',         type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'BEL', name: 'Belgium',         type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'BER', name: 'Berlin',          type: 'COASTAL', isSupplyCenter: true,  homePower: 'GERMANY', coasts: [] },
  { id: 'BRE', name: 'Brest',           type: 'COASTAL', isSupplyCenter: true,  homePower: 'FRANCE',  coasts: [] },
  { id: 'BUL', name: 'Bulgaria',        type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: ['EAST', 'SOUTH'] },
  { id: 'CLY', name: 'Clyde',           type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'CON', name: 'Constantinople',  type: 'COASTAL', isSupplyCenter: true,  homePower: 'TURKEY',  coasts: [] },
  { id: 'DEN', name: 'Denmark',         type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'EDI', name: 'Edinburgh',       type: 'COASTAL', isSupplyCenter: true,  homePower: 'ENGLAND', coasts: [] },
  { id: 'FIN', name: 'Finland',         type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'GAS', name: 'Gascony',         type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'GRE', name: 'Greece',          type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'HOL', name: 'Holland',         type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'KIE', name: 'Kiel',            type: 'COASTAL', isSupplyCenter: true,  homePower: 'GERMANY', coasts: [] },
  { id: 'LON', name: 'London',          type: 'COASTAL', isSupplyCenter: true,  homePower: 'ENGLAND', coasts: [] },
  { id: 'LVN', name: 'Livonia',         type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'LVP', name: 'Liverpool',       type: 'COASTAL', isSupplyCenter: true,  homePower: 'ENGLAND', coasts: [] },
  { id: 'MAR', name: 'Marseilles',      type: 'COASTAL', isSupplyCenter: true,  homePower: 'FRANCE',  coasts: [] },
  { id: 'NAF', name: 'North Africa',    type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'NAP', name: 'Naples',          type: 'COASTAL', isSupplyCenter: true,  homePower: 'ITALY',   coasts: [] },
  { id: 'NOR', name: 'Norway',          type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'PIC', name: 'Picardy',         type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'PIE', name: 'Piedmont',        type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'POR', name: 'Portugal',        type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'ROM', name: 'Rome',            type: 'COASTAL', isSupplyCenter: true,  homePower: 'ITALY',   coasts: [] },
  { id: 'RUM', name: 'Rumania',         type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'SER', name: 'Serbia',          type: 'LAND',    isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'SEV', name: 'Sevastopol',      type: 'COASTAL', isSupplyCenter: true,  homePower: 'RUSSIA',  coasts: [] },
  { id: 'SMY', name: 'Smyrna',          type: 'COASTAL', isSupplyCenter: true,  homePower: 'TURKEY',  coasts: [] },
  { id: 'SPA', name: 'Spain',           type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: ['NORTH', 'SOUTH'] },
  { id: 'STP', name: 'St. Petersburg',  type: 'COASTAL', isSupplyCenter: true,  homePower: 'RUSSIA',  coasts: ['NORTH', 'SOUTH'] },
  { id: 'SWE', name: 'Sweden',          type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'SYR', name: 'Syria',           type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'TRI', name: 'Trieste',         type: 'COASTAL', isSupplyCenter: true,  homePower: 'AUSTRIA', coasts: [] },
  { id: 'TUN', name: 'Tunis',           type: 'COASTAL', isSupplyCenter: true,  homePower: null,      coasts: [] },
  { id: 'TUS', name: 'Tuscany',         type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'VEN', name: 'Venice',          type: 'COASTAL', isSupplyCenter: true,  homePower: 'ITALY',   coasts: [] },
  { id: 'WAL', name: 'Wales',           type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
  { id: 'YOR', name: 'Yorkshire',       type: 'COASTAL', isSupplyCenter: false, homePower: null,      coasts: [] },
];

export const TERRITORY_MAP: Record<string, Territory> = Object.fromEntries(
  TERRITORIES.map(t => [t.id, t])
);

export const SUPPLY_CENTERS = TERRITORIES
  .filter(t => t.isSupplyCenter)
  .map(t => t.id);

export const HOME_SUPPLY_CENTERS: Record<string, string[]> = {
  AUSTRIA: ['VIE', 'TRI', 'BUD'],
  ENGLAND: ['LON', 'EDI', 'LVP'],
  FRANCE:  ['PAR', 'MAR', 'BRE'],
  GERMANY: ['BER', 'MUN', 'KIE'],
  ITALY:   ['ROM', 'VEN', 'NAP'],
  RUSSIA:  ['MOS', 'STP', 'WAR', 'SEV'],
  TURKEY:  ['CON', 'ANK', 'SMY'],
};
