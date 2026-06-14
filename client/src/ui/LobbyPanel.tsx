import type { useGameSocket } from '../hooks/useGameSocket.js';
import { useState } from 'react';

type GameSocket = ReturnType<typeof useGameSocket>;

export function LobbyPanel({ game }: { game: GameSocket }) {
  const [name, setName] = useState('Dev Player');
  const [joinCode, setJoinCode] = useState('');
  const players = game.gameState?.players ?? [];
  const missingCount = Math.max(0, 7 - players.length);
  const isHost = game.gameState?.hostPlayerId === game.myPlayerId;

  return (
    <section className="card">
      <h2>Game Setup</h2>
      <label>
        Player name
        <input value={name} onChange={event => setName(event.target.value)} />
      </label>
      <div className="button-row">
        <button className="primary" onClick={() => game.createGame(name)}>Create</button>
        <button onClick={() => game.joinGame(joinCode, name)} disabled={!joinCode.trim()}>Join</button>
      </div>
      <input placeholder="Game code" value={joinCode} onChange={event => setJoinCode(event.target.value)} />

      {game.gameState && (
        <>
          <div className="divider" />
          <div className="stat-row"><span>Status</span><strong>{game.gameState.status}</strong></div>
          <div className="stat-row"><span>Your power</span><strong>{game.myPower ?? '-'}</strong></div>
          <div className="stat-row"><span>Submitted</span><strong>{game.gameState.submittedPowers.length}/{players.length}</strong></div>
          <div className="button-row">
            <button onClick={() => game.addLlmPlayer()} disabled={!isHost || missingCount === 0 || game.gameState.status !== 'LOBBY'}>
              Add LLM
            </button>
            <button onClick={() => Array.from({ length: missingCount }).forEach(() => game.addLlmPlayer())} disabled={!isHost || missingCount === 0 || game.gameState.status !== 'LOBBY'}>
              Fill LLMs
            </button>
          </div>
          <button className="primary" onClick={game.startGame} disabled={!isHost || players.length < 7 || game.gameState.status !== 'LOBBY'}>
            Start Game
          </button>
        </>
      )}

      <div className="divider" />
      <h2>Players</h2>
      <div className="player-list">
        {players.map(player => (
          <div className="player-row" key={player.id}>
            <span>{player.power}</span>
            <strong>{player.name}{player.id === game.gameState?.hostPlayerId ? ' (host)' : ''}</strong>
            <em>{player.kind === 'HUMAN' ? (player.connected ? 'human online' : 'human offline') : `${player.provider} ${player.model}`}</em>
          </div>
        ))}
      </div>
    </section>
  );
}
