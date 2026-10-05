export interface PlayerCapabilities { providerSettings: boolean; discord: boolean; voice: boolean }
export interface PlayerSession {
  authenticated: boolean;
  enabled: boolean;
  profile: 'showcase' | 'private' | 'local';
  user: { id: string; displayName: string; provider: 'github' | 'google' } | null;
  operator: boolean;
  capabilities: PlayerCapabilities;
  providers: Array<'github' | 'google'>;
}
