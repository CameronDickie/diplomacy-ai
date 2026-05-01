import type { TerritoryId, Coast } from '../types/territory.js';

/**
 * Complete Diplomacy adjacency graph.
 * - army: territories an army can move to (land-adjacency; ignores sea zones)
 * - fleet: territories/sea-zones a fleet can move to from this territory's coast(s)
 *   For multi-coast territories (BUL, SPA, STP), fleet is a Record<Coast, TerritoryId[]>
 *   For all others, fleet is TerritoryId[]
 *
 * This is the authoritative source used by the adjudicator and the UI for
 * highlighting valid move destinations.
 */
export interface AdjacencyEntry {
  army: TerritoryId[];
  fleet: TerritoryId[] | Partial<Record<Coast, TerritoryId[]>>;
}

export const ADJACENCY: Record<TerritoryId, AdjacencyEntry> = {
  // ── Sea Zones ───────────────────────────────────────────────────────────────
  ADR: { army: [], fleet: ['ALB', 'APU', 'ION', 'TRI', 'VEN'] },
  AEG: { army: [], fleet: ['BUL', 'CON', 'EAS', 'GRE', 'ION', 'SMY'] },
  BAL: { army: [], fleet: ['BER', 'BOT', 'DEN', 'KIE', 'LVN', 'PRU', 'SWE'] },
  BAR: { army: [], fleet: ['NOR', 'NWG', 'STP'] },
  BLA: { army: [], fleet: ['ANK', 'ARM', 'BUL', 'CON', 'RUM', 'SEV'] },
  BOT: { army: [], fleet: ['BAL', 'FIN', 'LVN', 'STP', 'SWE'] },
  EAS: { army: [], fleet: ['AEG', 'ION', 'SMY', 'SYR'] },
  ENG: { army: [], fleet: ['BEL', 'BRE', 'IRI', 'LON', 'MAO', 'NTH', 'PIC', 'WAL'] },
  GOL: { army: [], fleet: ['MAR', 'PIE', 'SPA', 'TYS', 'WES'] },
  HEL: { army: [], fleet: ['DEN', 'HOL', 'KIE', 'NTH'] },
  ION: { army: [], fleet: ['ADR', 'AEG', 'ALB', 'APU', 'EAS', 'GRE', 'NAP', 'TUN', 'TYS'] },
  IRI: { army: [], fleet: ['ENG', 'LVP', 'MAO', 'NAO', 'WAL'] },
  MAO: { army: [], fleet: ['BRE', 'ENG', 'GAS', 'IRI', 'NAF', 'NAO', 'POR', 'SPA', 'WES'] },
  NAO: { army: [], fleet: ['CLY', 'IRI', 'LVP', 'MAO', 'NWG'] },
  NTH: { army: [], fleet: ['BEL', 'DEN', 'EDI', 'ENG', 'HEL', 'LON', 'NOR', 'NWG', 'SKA', 'YOR'] },
  NWG: { army: [], fleet: ['BAR', 'CLY', 'EDI', 'NAO', 'NOR', 'NTH'] },
  SKA: { army: [], fleet: ['DEN', 'NOR', 'NTH', 'SWE'] },
  TYS: { army: [], fleet: ['GOL', 'ION', 'NAP', 'ROM', 'TUN', 'TUS', 'WES'] },
  WES: { army: [], fleet: ['GOL', 'MAO', 'NAF', 'SPA', 'TUN', 'TYS'] },

  // ── Inland (LAND) territories — fleet adjacency empty ─────────────────────
  BOH: { army: ['GAL', 'MUN', 'SIL', 'TYR', 'VIE'],              fleet: [] },
  BUD: { army: ['GAL', 'RUM', 'SER', 'TRI', 'VIE'],              fleet: [] },
  BUR: { army: ['BEL', 'GAS', 'MAR', 'MUN', 'PAR', 'PIC', 'RUH'], fleet: [] },
  GAL: { army: ['BOH', 'BUD', 'RUM', 'SIL', 'UKR', 'VIE', 'WAR'], fleet: [] },
  MOS: { army: ['LVN', 'SEV', 'STP', 'UKR', 'WAR'],              fleet: [] },
  MUN: { army: ['BOH', 'BER', 'BUR', 'KIE', 'RUH', 'SIL', 'TYR'], fleet: [] },
  PAR: { army: ['BRE', 'BUR', 'GAS', 'PIC'],                     fleet: [] },
  RUH: { army: ['BEL', 'BUR', 'HOL', 'KIE', 'MUN'],              fleet: [] },
  SER: { army: ['ALB', 'BUD', 'BUL', 'GRE', 'RUM', 'TRI'],       fleet: [] },
  SIL: { army: ['BER', 'BOH', 'GAL', 'MUN', 'PRU', 'WAR'],       fleet: [] },
  TYR: { army: ['BOH', 'MUN', 'PIE', 'TRI', 'VEN', 'VIE'],       fleet: [] },
  UKR: { army: ['GAL', 'MOS', 'RUM', 'SEV', 'WAR'],               fleet: [] },
  VIE: { army: ['BOH', 'BUD', 'GAL', 'TRI', 'TYR'],              fleet: [] },
  WAR: { army: ['GAL', 'LVN', 'MOS', 'PRU', 'SIL', 'UKR'],       fleet: [] },

  // ── Coastal territories ────────────────────────────────────────────────────
  ALB: { army: ['GRE', 'SER', 'TRI'],                  fleet: ['ADR', 'GRE', 'ION', 'TRI'] },
  ANK: { army: ['ARM', 'CON', 'SMY'],                  fleet: ['ARM', 'BLA', 'CON'] },
  APU: { army: ['NAP', 'ROM', 'VEN'],                  fleet: ['ADR', 'ION', 'NAP', 'VEN'] },
  ARM: { army: ['ANK', 'SEV', 'SMY', 'SYR'],           fleet: ['ANK', 'BLA', 'SEV'] },
  BEL: { army: ['BUR', 'HOL', 'PIC', 'RUH'],           fleet: ['ENG', 'HOL', 'NTH', 'PIC'] },
  BER: { army: ['KIE', 'MUN', 'PRU', 'SIL'],           fleet: ['BAL', 'KIE'] },
  BRE: { army: ['GAS', 'PAR', 'PIC'],                  fleet: ['ENG', 'GAS', 'MAO', 'PIC'] },

  // Multi-coast: fleet adjacency keyed by coast
  BUL: {
    army: ['CON', 'GRE', 'RUM', 'SER'],
    fleet: {
      EAST:  ['BLA', 'RUM'],
      SOUTH: ['AEG', 'CON', 'GRE'],
    },
  },

  CLY: { army: ['EDI', 'LVP'],                         fleet: ['EDI', 'LVP', 'NAO', 'NWG'] },
  CON: { army: ['ANK', 'BUL', 'SMY'],                  fleet: ['AEG', 'ANK', 'BLA', 'BUL', 'SMY'] },
  DEN: { army: ['KIE', 'SWE'],                         fleet: ['BAL', 'HEL', 'KIE', 'NTH', 'SKA', 'SWE'] },
  EDI: { army: ['CLY', 'LVP', 'YOR'],                  fleet: ['CLY', 'NTH', 'NWG'] },
  FIN: { army: ['NOR', 'STP', 'SWE'],                  fleet: ['BOT', 'STP', 'SWE'] },
  GAS: { army: ['BRE', 'BUR', 'PAR', 'SPA'],           fleet: ['BRE', 'MAO', 'SPA'] },
  GRE: { army: ['ALB', 'BUL', 'SER'],                  fleet: ['AEG', 'ALB', 'BUL', 'ION'] },
  HOL: { army: ['BEL', 'KIE', 'RUH'],                  fleet: ['HEL', 'KIE', 'NTH'] },
  KIE: { army: ['BER', 'DEN', 'HOL', 'MUN', 'RUH'],   fleet: ['BAL', 'DEN', 'HEL', 'HOL'] },
  LON: { army: ['WAL', 'YOR'],                         fleet: ['ENG', 'NTH'] },
  LVN: { army: ['MOS', 'PRU', 'STP', 'WAR'],           fleet: ['BAL', 'BOT', 'PRU', 'STP'] },
  LVP: { army: ['CLY', 'EDI', 'WAL', 'YOR'],           fleet: ['CLY', 'IRI', 'NAO'] },
  MAR: { army: ['BUR', 'PIE', 'SPA'],                  fleet: ['GOL', 'SPA', 'WES'] },
  NAF: { army: ['TUN'],                                fleet: ['MAO', 'TUN', 'WES'] },
  NAP: { army: ['APU', 'ROM'],                         fleet: ['ION', 'TYS'] },
  NOR: { army: ['FIN', 'STP', 'SWE'],                  fleet: ['BAR', 'NTH', 'NWG', 'SKA', 'STP'] },
  PIC: { army: ['BEL', 'BRE', 'BUR', 'PAR'],          fleet: ['BEL', 'BRE', 'ENG'] },
  PIE: { army: ['MAR', 'TYR', 'TUS', 'VEN'],           fleet: ['GOL', 'TUS'] },
  POR: { army: ['SPA'],                                fleet: ['MAO', 'SPA'] },
  PRU: { army: ['BER', 'LVN', 'SIL', 'WAR'],           fleet: ['BAL', 'LVN'] },
  ROM: { army: ['APU', 'NAP', 'TUS', 'VEN'],           fleet: ['NAP', 'TUS', 'TYS'] },
  RUM: { army: ['BUD', 'BUL', 'GAL', 'SEV', 'SER', 'UKR'], fleet: ['BLA', 'BUL', 'SEV'] },
  SEV: { army: ['ARM', 'MOS', 'RUM', 'UKR'],           fleet: ['ARM', 'BLA', 'RUM'] },
  SMY: { army: ['ANK', 'ARM', 'CON', 'SYR'],           fleet: ['AEG', 'CON', 'EAS', 'SYR'] },

  // Multi-coast: fleet adjacency keyed by coast
  SPA: {
    army: ['GAS', 'MAR', 'POR'],
    fleet: {
      NORTH: ['GAS', 'MAO', 'POR'],
      SOUTH: ['GOL', 'MAR', 'MAO', 'WES'],
    },
  },

  // Multi-coast: fleet adjacency keyed by coast
  STP: {
    army: ['FIN', 'LVN', 'MOS', 'NOR'],
    fleet: {
      NORTH: ['BAR', 'NOR'],
      SOUTH: ['BOT', 'FIN', 'LVN'],
    },
  },

  SWE: { army: ['DEN', 'FIN', 'NOR'],                  fleet: ['BAL', 'BOT', 'DEN', 'FIN', 'NOR', 'SKA'] },
  SYR: { army: ['ARM', 'SMY'],                         fleet: ['EAS', 'SMY'] },
  TRI: { army: ['ALB', 'BUD', 'SER', 'TYR', 'VEN', 'VIE'], fleet: ['ADR', 'ALB', 'VEN'] },
  TUN: { army: ['NAF'],                                fleet: ['ION', 'NAF', 'TYS', 'WES'] },
  TUS: { army: ['PIE', 'ROM', 'VEN'],                  fleet: ['GOL', 'ROM', 'TYS'] },
  VEN: { army: ['APU', 'PIE', 'ROM', 'TRI', 'TUS', 'TYR'], fleet: ['ADR', 'APU', 'TRI'] },
  WAL: { army: ['LON', 'LVP', 'YOR'],                  fleet: ['ENG', 'IRI'] },
  YOR: { army: ['EDI', 'LON', 'LVP', 'WAL'],           fleet: ['ENG', 'NTH'] },
};

/**
 * Returns fleet adjacency for a unit in `territory` on optional `coast`.
 * For non-multi-coast territories coast is ignored.
 */
export function getFleetAdjacency(territory: TerritoryId, coast?: string | null): TerritoryId[] {
  const entry = ADJACENCY[territory];
  if (!entry) return [];
  const f = entry.fleet;
  if (Array.isArray(f)) return f;
  // Multi-coast territory
  if (coast && coast in f) return (f as Record<string, TerritoryId[]>)[coast] ?? [];
  // Return all reachable territories across all coasts (for validation purposes)
  return Object.values(f as Record<string, TerritoryId[]>).flat();
}

/**
 * Returns army adjacency for a unit in `territory`.
 */
export function getArmyAdjacency(territory: TerritoryId): TerritoryId[] {
  return ADJACENCY[territory]?.army ?? [];
}
