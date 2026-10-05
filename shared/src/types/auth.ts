export interface PlayerSession {
  authenticated: boolean;
  enabled: boolean;
  profile: 'showcase' | 'private' | 'local';
  user: { id: string; displayName: string; provider: 'github' | 'google' } | null;
  operator: boolean;
  providers: Array<'github' | 'google'>;
}
