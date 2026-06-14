import type { useGameSocket } from '../hooks/useGameSocket.js';
import type { LlmProviderId, Power } from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import { useState } from 'react';

type GameSocket = ReturnType<typeof useGameSocket>;

export function LobbyPanel({ game }: { game: GameSocket }) {
  const [name, setName] = useState('Dev Player');
  const [joinCode, setJoinCode] = useState('');
  const [preferredPower, setPreferredPower] = useState<Power | 'RANDOM'>('RANDOM');
  const [llmPower, setLlmPower] = useState<Power | 'RANDOM'>('RANDOM');
  const [llmProvider, setLlmProvider] = useState<LlmProviderId>('STUB');
  const [llmModel, setLlmModel] = useState('auto-hold-v0');
  const [llmPersona, setLlmPersona] = useState('');
  const players = game.gameState?.players ?? [];
  const availablePowers = ALL_POWERS.filter(
    power => !players.some(player => player.power === power)
  );
  const missingCount = Math.max(0, 7 - players.length);
  const isHost = game.gameState?.hostPlayerId === game.myPlayerId;

  return (
    <section className="card">
      <h2>Game Setup</h2>
      <label>
        Player name
        <input value={name} onChange={event => setName(event.target.value)} />
      </label>
      <label>
        Country
        <select
          value={preferredPower}
          onChange={event => setPreferredPower(event.target.value as Power | 'RANDOM')}
        >
          <option value="RANDOM">Random available</option>
          {ALL_POWERS.map(power => <option value={power} key={power}>{power}</option>)}
        </select>
      </label>
      <div className="button-row">
        <button
          className="primary"
          onClick={() => game.createGame(name, preferredPower)}
        >
          Create
        </button>
        <button
          onClick={() => game.joinGame(joinCode, name, preferredPower)}
          disabled={!joinCode.trim()}
        >
          Join
        </button>
      </div>
      <input placeholder="Game code" value={joinCode} onChange={event => setJoinCode(event.target.value)} />

      {game.gameState && (
        <>
          <div className="divider" />
          <div className="stat-row"><span>Status</span><strong>{game.gameState.status}</strong></div>
          <div className="stat-row"><span>Your power</span><strong>{game.myPower ?? '-'}</strong></div>
          <div className="stat-row"><span>Submitted</span><strong>{game.gameState.submittedPowers.length}/{players.length}</strong></div>
          {isHost && game.gameState.status === 'LOBBY' && (
            <div className="llm-config">
              <h3>Automated diplomacy</h3>
              <label>
                LLM conversations per order phase
                <select
                  value={game.gameState.settings.llmNegotiationInitiators}
                  onChange={event =>
                    game.updateLlmNegotiationInitiators(Number(event.target.value))
                  }
                >
                  {Array.from({ length: 8 }, (_, count) => (
                    <option value={count} key={count}>{count}</option>
                  ))}
                </select>
              </label>
              <p className="field-help">
                Maximum LLM-initiated exchanges after all human orders are submitted.
              </p>
              <h3>Next LLM seat</h3>
              <label>
                Country
                <select
                  value={llmPower}
                  onChange={event => setLlmPower(event.target.value as Power | 'RANDOM')}
                >
                  <option value="RANDOM">Next available</option>
                  {availablePowers.map(power => (
                    <option value={power} key={power}>{power}</option>
                  ))}
                </select>
              </label>
              <label>
                Provider
                <select
                  value={llmProvider}
                  onChange={event => {
                    const provider = event.target.value as LlmProviderId;
                    setLlmProvider(provider);
                    setLlmModel(provider === 'OPENAI' ? 'gpt-5.5' : 'auto-hold-v0');
                  }}
                >
                  <option value="STUB">Stub (auto-hold)</option>
                  <option value="OPENAI">OpenAI</option>
                </select>
              </label>
              <label>
                Model
                <input
                  value={llmModel}
                  onChange={event => setLlmModel(event.target.value)}
                />
              </label>
              <label>
                Persona
                <input
                  placeholder="Optional diplomatic style"
                  value={llmPersona}
                  onChange={event => setLlmPersona(event.target.value)}
                />
              </label>
            </div>
          )}
          <div className="button-row">
            <button
              onClick={() => game.addLlmPlayer({
                power: llmPower,
                provider: llmProvider,
                model: llmModel,
                persona: llmPersona || null,
              })}
              disabled={!isHost || missingCount === 0 || game.gameState.status !== 'LOBBY'}
            >
              Add LLM
            </button>
            <button
              onClick={() => Array.from({ length: missingCount }).forEach(() =>
                game.addLlmPlayer({
                  power: 'RANDOM',
                  provider: llmProvider,
                  model: llmModel,
                  persona: llmPersona || null,
                })
              )}
              disabled={!isHost || missingCount === 0 || game.gameState.status !== 'LOBBY'}
            >
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
            <em>
              {player.kind === 'HUMAN'
                ? (player.connected ? 'human online' : 'human offline')
                : `${player.provider} ${player.model}`}
            </em>
          </div>
        ))}
      </div>
    </section>
  );
}
