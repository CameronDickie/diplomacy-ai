export type Power =
  | 'AUSTRIA'
  | 'ENGLAND'
  | 'FRANCE'
  | 'GERMANY'
  | 'ITALY'
  | 'RUSSIA'
  | 'TURKEY';

export const ALL_POWERS: Power[] = [
  'AUSTRIA',
  'ENGLAND',
  'FRANCE',
  'GERMANY',
  'ITALY',
  'RUSSIA',
  'TURKEY',
];

export type Season = 'SPRING' | 'FALL' | 'WINTER';

export type Phase = 'ORDERS' | 'RETREATS' | 'BUILDS';

export type GameStatus = 'LOBBY' | 'IN_PROGRESS' | 'FINISHED';
