/**
 * `games`: hosted games exist here. `practiceBots`: any host may fill empty seats with the free offline bots.
 * `recordedGames`: the AI games viewer is offered (local development, or games the owner published).
 */
export interface PlayerCapabilities { providerSettings: boolean; discord: boolean; voice: boolean; games: boolean; practiceBots: boolean; recordedGames: boolean }
export interface PlayerSession {
  authenticated: boolean;
  enabled: boolean;
  profile: 'showcase' | 'private' | 'local';
  user: { id: string; displayName: string; provider: 'github' | 'google' } | null;
  operator: boolean;
  capabilities: PlayerCapabilities;
  providers: Array<'github' | 'google'>;
  /** Development only: this server offers a sign-in that needs no identity provider. */
  devSignIn?: boolean;
}
