import { useAuth } from '../hooks/useAuth.js';
import { RoomApp } from '../rooms/RoomApp.js';
import { ViewerApp } from '../viewer/ViewerApp.js';
import { ChallengeApp } from './ChallengeApp.js';

/**
 * Two ways to play, in one frame. `/challenge` is the daily challenge; `/` is hosted games, which
 * people create and play to the end. The showcase profile has hosted games only once the owner turns
 * them on (`capabilities.games`); until then the challenge is the whole site. `/viewer` replays
 * recorded model-only games: in local development, and on the public site once the owner publishes some.
 */
export function App() {
  const auth = useAuth();
  const challenge = window.location.pathname === '/challenge';
  // The game viewer reads records the development server serves, or the ones the owner published; anywhere else the address shows the usual site.
  const viewer = window.location.pathname === '/viewer';
  if (viewer && auth.status === 'CHECKING') return null;
  if (viewer && auth.capabilities.recordedGames) return <ViewerApp />;
  // Until the server says which profile this is, `/` shows the hosted-games frame, which waits quietly.
  return challenge || (auth.status !== 'CHECKING' && auth.profile === 'showcase' && !auth.capabilities.games) ? <ChallengeApp /> : <RoomApp />;
}
