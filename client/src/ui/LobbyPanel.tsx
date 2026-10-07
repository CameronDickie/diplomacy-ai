import type { useGameSocket } from '../hooks/useGameSocket.js';
import type { LlmProviderId, Power } from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import { useState } from 'react';
import { useAuth } from '../hooks/useAuth.js';

type GameSocket = ReturnType<typeof useGameSocket>;

const MODEL_SUGGESTIONS: Partial<Record<LlmProviderId, string[]>> = {
  OPENAI: [
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.4',
  ],
  GEMINI: [
    'gemini-3.1-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.5-flash',
  ],
};

export function LobbyPanel({ game }: { game: GameSocket }) {
  const auth = useAuth();
  const [name, setName] = useState('Dev Player');
  const [joinCode, setJoinCode] = useState('');
  const [preferredPower, setPreferredPower] = useState<Power | 'RANDOM'>('RANDOM');
  const [llmPower, setLlmPower] = useState<Power | 'RANDOM'>('RANDOM');
  const [llmProvider, setLlmProvider] = useState<LlmProviderId>('STUB');
  const [llmModel, setLlmModel] = useState('auto-hold-v0');
  const [llmPersona, setLlmPersona] = useState('');
  const [llmRealtimeModel, setLlmRealtimeModel] = useState('gpt-realtime-2');
  const [llmVoice, setLlmVoice] = useState('');
  const [llmVoiceInstructions, setLlmVoiceInstructions] = useState('');
  const players = game.gameState?.players ?? [];
  const availablePowers = ALL_POWERS.filter(
    power => !players.some(player => player.power === power)
  );
  const missingCount = Math.max(0, 7 - players.length);
  const isHost = game.gameState?.hostPlayerId === game.myPlayerId;
  const aiControlsLocked = !auth.capabilities.providerSettings;
  const canEditLobbyAi = Boolean(isHost && game.gameState?.status === 'LOBBY' && !aiControlsLocked);

  if (auth.profile === 'showcase') return <section className="card">
    <h2>Daily challenges</h2>
    <p>Challenge play is not available on this server yet.</p>
  </section>;

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
          {isHost && game.gameState.status === 'LOBBY' && auth.capabilities.providerSettings && (
            <div className="llm-config">
              <h3>Automated diplomacy</h3>
              <label>
                LLM conversations per order phase
                <select
                  value={game.gameState.settings.llmNegotiationInitiators}
                  disabled={aiControlsLocked}
                  onChange={event =>
                    game.updateGameSettings({
                      llmNegotiationInitiators: Number(event.target.value),
                    })
                  }
                >
                  {Array.from({ length: 8 }, (_, count) => (
                    <option value={count} key={count}>{count}</option>
                  ))}
                </select>
              </label>
              <p className="field-help">
                Maximum LLM powers that may initiate a conversation each order phase.
              </p>
              <label>
                Planner model
                <input
                  placeholder="Use each seat's model"
                  value={game.gameState.settings.llmNegotiationPlannerModel}
                  disabled={aiControlsLocked}
                  onChange={event => game.updateGameSettings({
                    llmNegotiationPlannerModel: event.target.value,
                  })}
                />
              </label>
              <p className="field-help">
                Optional cheaper model, using the same provider, for choosing a recipient and
                writing the opening message.
              </p>
              <label>
                Message warning
                <select
                  value={game.gameState.settings.llmNegotiationWarningAtMessages}
                  disabled={aiControlsLocked}
                  onChange={event => game.updateGameSettings({
                    llmNegotiationWarningAtMessages: Number(event.target.value),
                  })}
                >
                  {Array.from(
                    { length: game.gameState.settings.llmNegotiationMaxMessages },
                    (_, index) => index + 1
                  ).map(count => <option value={count} key={count}>{count}</option>)}
                </select>
              </label>
              <label>
                Hard message cap
                <select
                  value={game.gameState.settings.llmNegotiationMaxMessages}
                  disabled={aiControlsLocked}
                  onChange={event => {
                    const max = Number(event.target.value);
                    game.updateGameSettings({
                      llmNegotiationMaxMessages: max,
                      llmNegotiationWarningAtMessages: Math.min(
                        game.gameState!.settings.llmNegotiationWarningAtMessages,
                        max
                      ),
                    });
                  }}
                >
                  {Array.from({ length: 19 }, (_, index) => index + 2).map(count => (
                    <option value={count} key={count}>{count}</option>
                  ))}
                </select>
              </label>
              <p className="field-help">
                Models are urged to conclude at the warning threshold. The server always stops
                the exchange at the hard cap.
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={game.gameState.settings.publicLlmConversationPresence}
                  disabled={aiControlsLocked}
                  onChange={event => game.updateGameSettings({
                    publicLlmConversationPresence: event.target.checked,
                  })}
                />
                Show autonomous conversation pairings to every player
              </label>
              <p className="field-help">
                Off by default so private diplomatic activity does not reveal who is coordinating.
              </p>
              {auth.capabilities.voice && <>
                <h3>Voice limits</h3>
                <label>
                  Maximum session minutes
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={game.gameState.settings.voiceMaxSessionMinutes}
                    disabled={aiControlsLocked}
                    onChange={event => game.updateGameSettings({
                      voiceMaxSessionMinutes: Number(event.target.value),
                    })}
                  />
                </label>
                <label>
                  Maximum human turns
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={game.gameState.settings.voiceMaxTurns}
                    disabled={aiControlsLocked}
                    onChange={event => game.updateGameSettings({
                      voiceMaxTurns: Number(event.target.value),
                    })}
                  />
                </label>
                <label>
                  Idle timeout seconds
                  <input
                    type="number"
                    min={15}
                    max={300}
                    value={game.gameState.settings.voiceIdleTimeoutSeconds}
                    disabled={aiControlsLocked}
                    onChange={event => game.updateGameSettings({
                      voiceIdleTimeoutSeconds: Number(event.target.value),
                    })}
                  />
                </label>
                <label>
                  Auto-commit silence seconds
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={0.5}
                    value={game.gameState.settings.voiceAutoCommitSilenceSeconds}
                    disabled={aiControlsLocked}
                    onChange={event => game.updateGameSettings({
                      voiceAutoCommitSilenceSeconds: Number(event.target.value),
                    })}
                  />
                </label>
                <p className="field-help">
                  Voice auto-listen commits a player's turn after this much silence.
                </p>
              </>}
              <h3>Next LLM seat</h3>
              <label>
                Country
                <select
                  value={llmPower}
                  disabled={aiControlsLocked}
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
                  disabled={aiControlsLocked}
                  onChange={event => {
                    const provider = event.target.value as LlmProviderId;
                    if (provider === 'OPENAI' && !auth.operator) return;
                    if (provider === 'GEMINI' && !auth.operator) return;
                    if (provider === 'OLLAMA' && !auth.operator) return;
                    setLlmProvider(provider);
                    // An empty Ollama model means the server's configured default.
                    setLlmModel(provider === 'OPENAI'
                      ? 'gpt-5.4-mini'
                      : provider === 'GEMINI' ? 'gemini-3.1-flash-lite'
                        : provider === 'OLLAMA' ? '' : 'auto-hold-v0');
                  }}
                >
                  <option value="STUB">Stub (auto-hold)</option>
                  <option value="OPENAI" disabled={!auth.operator}>OpenAI</option>
                  <option value="GEMINI" disabled={!auth.operator}>Gemini</option>
                  <option value="OLLAMA" disabled={!auth.operator}>Ollama (local)</option>
                </select>
              </label>
              <label>
                Model
                <input
                  list="llm-model-options"
                  value={llmModel}
                  disabled={aiControlsLocked}
                  onChange={event => setLlmModel(event.target.value)}
                />
                <datalist id="llm-model-options">
                  {(MODEL_SUGGESTIONS[llmProvider] ?? []).map(model => (
                    <option value={model} key={model} />
                  ))}
                </datalist>
              </label>
              <label>
                Persona
                <input
                  placeholder="Optional diplomatic style"
                  value={llmPersona}
                  disabled={aiControlsLocked}
                  onChange={event => setLlmPersona(event.target.value)}
                />
              </label>
              {auth.capabilities.voice && <>
                <label>
                  Realtime voice model
                  <input
                    value={llmRealtimeModel}
                    disabled={aiControlsLocked}
                    onChange={event => setLlmRealtimeModel(event.target.value)}
                  />
                </label>
                <label>
                  Voice override
                  <input
                    placeholder="Auto by country"
                    value={llmVoice}
                    disabled={aiControlsLocked}
                    onChange={event => setLlmVoice(event.target.value)}
                  />
                </label>
                <p className="field-help">
                  Leave blank to give each country a stable default voice. Supported overrides:
                  alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar.
                </p>
                <label>
                  Voice persona instructions
                  <textarea
                    placeholder="Optional spoken style and pacing"
                    value={llmVoiceInstructions}
                    disabled={aiControlsLocked}
                    onChange={event => setLlmVoiceInstructions(event.target.value)}
                  />
                </label>
              </>}
            </div>
          )}
          <div className="button-row">
            {auth.profile === 'local' && !auth.operator && isHost && game.gameState.status === 'LOBBY' && <button
              disabled={missingCount === 0}
              onClick={() => game.addLlmPlayer({ provider: 'STUB', model: 'auto-hold-v0' })}
            >Add offline bot</button>}
            {auth.capabilities.providerSettings && <>
              <button
                onClick={() => game.addLlmPlayer({
                  power: llmPower,
                  provider: llmProvider,
                  model: llmModel,
                  persona: llmPersona || null,
                  realtimeModel: llmRealtimeModel,
                  voice: llmVoice.trim() || undefined,
                  voiceInstructions: llmVoiceInstructions || null,
                })}
                disabled={!canEditLobbyAi || missingCount === 0}
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
                    realtimeModel: llmRealtimeModel,
                    voice: llmVoice.trim() || undefined,
                    voiceInstructions: llmVoiceInstructions || null,
                  })
                )}
                disabled={!canEditLobbyAi || missingCount === 0}
              >
                Fill LLMs
              </button>
            </>}
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
