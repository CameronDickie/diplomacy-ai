import { useEffect, useState, type ReactNode } from 'react';
import { ALL_POWERS, type Power } from '@diplomacy/shared';
import { ArrowFillButton } from '../challenge/Shell.js';
import { title } from '../challenge/text.js';
import { useAuth } from '../hooks/useAuth.js';
import type { useGameSocket } from '../hooks/useGameSocket.js';
import { fullGamesApi, type FullGamesList } from '../viewer/FullGames.js';

type GameSocket = ReturnType<typeof useGameSocket>;
type Seat = Power | 'RANDOM';

/**
 * The start of every full game: against the AI, with friends, or just watching. Each way is a card in
 * the same pattern as the daily challenge's ways to play, saying who decides the other powers. A way
 * this server does not offer says so instead of disappearing, so the page reads the same everywhere.
 * Below them, the games you are playing against the AI.
 */
export function GamesHome({ game, map }: { game: GameSocket; map: ReactNode }) {
  const auth = useAuth();
  // The AI games service answers only where it runs; elsewhere playing and watching AI games are not offered.
  const [ai, setAi] = useState<FullGamesList | null | 'unavailable'>(null);
  const [records, setRecords] = useState(0);
  useEffect(() => {
    fullGamesApi.list().then(setAi).catch(() => setAi('unavailable'));
    fetch('/game-records/index.json').then(r => r.ok ? r.json() : null).then((body: { games?: unknown[] } | null) => setRecords(body?.games?.length ?? 0)).catch(() => setRecords(0));
  }, []);
  const service = ai && ai !== 'unavailable' ? ai : null;
  const yours = service ? service.games.filter(g => g.seat).reverse() : [];
  const watchable = (service?.games.length ?? 0) + records > 0;

  return <main id="dip-content">
    <div className="dip-setup">
      <div className="dip-heading">
        <p className="dip-meta">Games</p>
        <h1>Play a <span>full game</span></h1>
        <p>All seven powers, from Spring 1901 until one of them controls 18 supply centers. Take on AI opponents, play with friends, or watch the AI play itself.</p>
      </div>
      <div className="dip-map games-hero-map" style={{ height: 'min(56dvh, 520px)', marginTop: 40 }}>{map}</div>
    </div>

    <section className="dip-section" aria-labelledby="games-ways">
      <h2 id="games-ways">Choose how to play</h2>
      <ol className="dip-modes">
        <li className="dip-mode"><span>01 · AGAINST THE AI</span><h3>Play against the AI</h3>
          <dl><dt>You play</dt><dd>One power of your choice</dd><dt>Opponents</dt><dd>Six AI models, one per power</dd><dt>Messages</dt><dd>They write to you every turn, and reply</dd></dl>
          <p>Each orders turn the AI powers write first, you answer anyone you like, they reply, and everyone gives orders. The game waits for you.</p>
          {service ? <ArrowFillButton onClick={() => { window.location.href = '/viewer#/new'; }}>Set up a game</ArrowFillButton>
            : <p className="dip-small dip-muted" role="status">{ai === null ? 'Checking whether this server offers AI games…' : 'Not offered on this server yet.'}</p>}</li>
        <li className="dip-mode"><span>02 · WITH FRIENDS</span><h3>Play with friends</h3>
          <dl><dt>Players</dt><dd>People you share a game code with</dd><dt>Empty seats</dt><dd>{auth.capabilities.providerSettings ? 'AI opponents or people' : auth.profile === 'local' ? 'Offline bots or people' : 'Filled by people joining'}</dd><dt>Messages</dt><dd>Private, between any two powers</dd></dl>
          <FriendsForm game={game} /></li>
        <li className="dip-mode"><span>03 · WATCH</span><h3>Watch AI games</h3>
          <dl><dt>Players</dt><dd>AI models on every power</dd><dt>See</dt><dd>Every order, message and result, turn by turn</dd><dt>Account</dt><dd>Not needed</dd></dl>
          <p>Step through recorded games between AI models, or watch one being played.</p>
          {watchable ? <ArrowFillButton onClick={() => { window.location.href = '/viewer'; }}>Watch AI games</ArrowFillButton>
            : <p className="dip-small dip-muted" role="status">{ai === null ? 'Looking for games…' : 'No AI games on this server yet.'}</p>}</li>
      </ol>
    </section>

    {yours.length > 0 && <section className="dip-section" aria-labelledby="games-yours">
      <h2 id="games-yours">Your games against the AI</h2>
      <ul className="dip-list">{yours.map(g => {
        const state = g.waiting ? 'Waiting for you' : g.running ? 'Being played' : g.lifecycle === 'ACTIVE' ? 'Paused' : 'Finished';
        return <li key={g.runId}><span><a href={`/viewer#/db/${g.runId}`}><strong>{g.runId}</strong></a>
          <small>You play {title(g.seat!)} · {state} · {title(g.season)} {g.year} · {g.centers[g.seat!]} center{g.centers[g.seat!] === 1 ? '' : 's'}</small></span>
          <a href={`/viewer#/db/${g.runId}`}>{g.waiting ? 'Play' : g.lifecycle === 'ACTIVE' ? 'Continue' : 'Review'}</a></li>;
      })}</ul>
    </section>}

    {game.connection !== 'connected' && game.connection !== 'idle' && <p className="dip-small" role="status" style={{ color: 'var(--folio-warning)' }}>
      {game.connection === 'connecting' ? 'Connecting to the game server…' : 'Not connected to the game server. Reconnecting automatically.'}</p>}

    <section className="dip-section">
      <h2>Short on time?</h2>
      <p className="dip-muted">The <a href="/challenge">daily challenge</a> is a single scenario with one objective and a deadline, played alone against the other six powers.</p>
    </section>
  </main>;
}

/** Create a game to share by code, or join one: one name and power for both. */
function FriendsForm({ game }: { game: GameSocket }) {
  const auth = useAuth();
  const [name, setName] = useState(() => auth.user?.displayName ?? 'Player');
  const [power, setPower] = useState<Seat>('RANDOM');
  const [code, setCode] = useState('');
  const ready = name.trim().length > 0;
  return <div className="games-friends">
    <div className="dip-form-grid">
      <label>Your name<input value={name} maxLength={40} autoComplete="nickname" onChange={event => setName(event.target.value)} /></label>
      <label>Power you would like
        <select value={power} onChange={event => setPower(event.target.value as Seat)}>
          <option value="RANDOM">Any free power</option>
          {ALL_POWERS.map(option => <option value={option} key={option}>{title(option)}</option>)}
        </select></label>
    </div>
    <p className="dip-small dip-muted">Create a game and you are its host: you get a code to share, decide how empty seats are filled, and start it.</p>
    <ArrowFillButton disabled={!ready} onClick={() => game.createGame(name.trim(), power)}>Create a game</ArrowFillButton>
    <form className="games-join" onSubmit={event => { event.preventDefault(); if (ready && code.trim()) game.joinGame(code.trim(), name.trim(), power); }}>
      <label>Or join with a code<input value={code} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="C447A36E" onChange={event => setCode(event.target.value)} /></label>
      <button type="submit" className="dip-solid" disabled={!ready || !code.trim()}>Join</button>
    </form>
  </div>;
}
