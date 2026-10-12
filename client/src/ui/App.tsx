import { useAuth } from '../hooks/useAuth.js';
import { RoomApp } from '../rooms/RoomApp.js';
import { ChallengeApp } from './ChallengeApp.js';

/**
 * Two ways to play, in one frame. `/challenge` is the daily challenge; `/` is hosted games, which
 * people create and play to the end. The showcase profile has no hosted games, so there the
 * challenge is the whole site.
 */
export function App() {
  const auth = useAuth();
  const challenge = window.location.pathname === '/challenge';
  // Until the server says which profile this is, `/` shows the hosted-games frame, which waits quietly.
  return challenge || (auth.status !== 'CHECKING' && auth.profile === 'showcase') ? <ChallengeApp /> : <RoomApp />;
}
