import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ALL_POWERS, type LlmProviderId, type Player, type Power } from '@diplomacy/shared';
import { ArrowFillButton } from '../challenge/Shell.js';
import { phaseTitle, title } from '../challenge/text.js';
import { useAuth } from '../hooks/useAuth.js';
import type { useGameSocket } from '../hooks/useGameSocket.js';
import { POWER_COLORS } from '../lib/game.js';
import { centers, powerStatus } from './Play.js';

/** The free practice bot seat (`server/src/llm/PracticeBotController.ts`). */
const PRACTICE_BOT = 'practice-bot-v1';
/** Set by the Games home's "against practice bots": the game it creates is filled with them and started. */
export const PRACTICE_START = 'dip-practice-start';

type GameSocket = ReturnType<typeof useGameSocket>;
type Seat = Power | 'RANDOM';

const MODEL_SUGGESTIONS: Partial<Record<LlmProviderId, string[]>> = {
  OPENAI: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4'],
  GEMINI: ['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash'],
};
const DEFAULT_MODEL: Record<string, string> = { OPENAI: 'gpt-5.4-mini', GEMINI: 'gemini-3.1-flash-lite', OLLAMA: '', STUB: 'auto-hold-v0' };
const seatKind = (player: Player) => player.kind === 'HUMAN' ? (player.connected ? 'Person · online' : 'Person · offline')
  : player.provider === 'STUB' ? (player.model === PRACTICE_BOT ? 'Practice bot · free, no AI model' : 'Offline bot · always holds') : `AI · ${player.provider} ${player.model}`;

/**
 * Everything about the game itself, away from the turn: who sits where, how empty seats are filled,
 * the host's settings and the start. Once the game is running it becomes the reference page for
 * players, supply centers and voice. Creating or joining a game starts on the Games home.
 */
export function GameView({ game, map, onPlay }: { game: GameSocket; map: ReactNode; onPlay: () => void }) {
  const auth = useAuth();
  const state = game.gameState;
  const players = state?.players ?? [];
  const empty = Math.max(0, 7 - players.length);
  const isHost = Boolean(state && state.hostPlayerId === game.myPlayerId);
  const lobby = state?.status === 'LOBBY';
  const host = players.find(player => player.id === state?.hostPlayerId);
  usePracticeStart(game, isHost && lobby, empty);

  return <main id="dip-content">
    <div className="dip-setup">
      <div>
        <div className="dip-heading">
          <p className="dip-meta">Hosted games{state ? ` · game ${state.gameId}` : ''}</p>
          {!state ? null : lobby ? <h1>Waiting for <span>players</span></h1>
            : state.status === 'FINISHED' ? <h1>Game <span>over</span></h1> : <h1>Game in <span>progress</span></h1>}
          {!state ? null : lobby ? <p>Share the code <strong>{state.gameId}</strong> with the people you want to play. The game needs all seven seats filled before {isHost ? 'you' : 'the host'} can start it.</p>
            : state.status === 'FINISHED' ? <p>{state.winner ? `${title(state.winner)} won.` : 'The game has ended.'} The orders log is still available under History.</p>
            : <p>{phaseTitle(state)}. Orders are given on the Play page.</p>}
        </div>
        {state && <dl className="dip-facts" aria-label="Game details">
          <div><dt>Game code</dt><dd>{state.gameId}</dd></div>
          <div><dt>You play</dt><dd>{game.myPower ? title(game.myPower) : 'Not seated'}</dd></div>
          <div><dt>Host</dt><dd>{host ? `${host.name}${isHost ? ' (you)' : ''}` : '—'}</dd></div>
          <div><dt>{lobby ? 'Seats filled' : 'Turn'}</dt><dd>{lobby ? `${players.length} of 7` : state.status === 'FINISHED' ? 'Finished' : phaseTitle(state)}</dd></div>
        </dl>}
        {state && !lobby && <div className="dip-orders-actions" style={{ marginTop: 24 }}><ArrowFillButton onClick={onPlay}>{state.status === 'FINISHED' ? 'See the final board' : 'Go to the map'}</ArrowFillButton></div>}
        {game.connection !== 'connected' && game.connection !== 'idle' && <p className="dip-small" role="status" style={{ marginTop: 16, color: 'var(--folio-warning)' }}>
          {game.connection === 'connecting' ? 'Connecting to the game server…' : 'Not connected to the game server. Reconnecting automatically.'}</p>}
      </div>
      <div className="dip-map" style={{ height: 'min(56dvh, 520px)', marginTop: 40 }}>{map}</div>
    </div>

    {state && <section className="dip-section" aria-labelledby="room-seats">
      <h2 id="room-seats">{lobby ? 'Seats' : 'Powers'}</h2>
      <ul className="dip-list">{ALL_POWERS.map(power => {
        const player = players.find(candidate => candidate.power === power);
        return <li key={power}>
          <span><i className="dip-swatch" style={{ background: POWER_COLORS[power] }} aria-hidden="true" />{title(power)}{power === game.myPower ? ' (you)' : ''}
            <small>{player ? [player.kind === 'HUMAN' ? player.name : null, player.id === state.hostPlayerId ? 'host' : null, seatKind(player)].filter(Boolean).join(' · ') : lobby ? 'Empty seat' : 'Nobody'}</small>
            {!lobby && player && power !== game.myPower && <VoiceControls game={game} player={player} />}</span>
          {!lobby && <span className="dip-small dip-muted">{centers(state, power)} center{centers(state, power) === 1 ? '' : 's'} · {state.units.filter(unit => unit.power === power).length} units
            {powerStatus(game, state, power) ? ` · ${powerStatus(game, state, power)}` : ''}</span>}
        </li>;
      })}</ul>
    </section>}

    {state && lobby && <section className="dip-section" aria-labelledby="room-fill">
      <h2 id="room-fill">Fill the empty seats</h2>
      {!isHost ? <p className="dip-muted">Only the host can add opponents and start the game.</p>
        : empty === 0 ? <p className="dip-muted">Every seat is taken. You can start the game.</p>
        : <FillSeats game={game} empty={empty} taken={players.map(player => player.power)} />}
      {isHost && <div className="dip-orders-actions" style={{ marginTop: 24 }}>
        <ArrowFillButton onClick={game.startGame} disabled={players.length < 7}>Start the game</ArrowFillButton>
        {players.length < 7 && <span className="dip-small dip-muted">{empty} seat{empty === 1 ? ' is' : 's are'} still empty.</span>}
      </div>}
    </section>}

    {state && lobby && isHost && auth.capabilities.providerSettings && <HostSettings game={game} voice={auth.capabilities.voice} />}
    {state && game.capabilities.discord && <DiscordSection game={game} isHost={isHost} />}

    {state && game.myPower && <LeaveGame game={game} />}

    <section className="dip-section" style={{ marginTop: 28 }}>
      <h2>Other ways to play</h2>
      <p className="dip-muted">{auth.profile === 'local' && <><a href="/viewer#/new">Play against the AI</a>, <a href="/viewer">watch AI games</a>, or try </>}{auth.profile === 'local' ? 'the' : 'Try the'} <a href="/challenge">daily challenge</a>: a single scenario with one objective and a deadline, played alone against the other six powers.</p>
    </section>
  </main>;
}

/**
 * This browser holds one seat at a time, so creating or joining another game starts with leaving this
 * one. In the lobby the seat is freed; once the game is running a practice bot plays the power from
 * here on, so the others are not left waiting. Leaving cannot be undone.
 */
function LeaveGame({ game }: { game: GameSocket }) {
  const [asking, setAsking] = useState(false);
  const state = game.gameState!, power = title(game.myPower!);
  const effect = state.status === 'LOBBY' ? `Your seat as ${power} is freed for someone else.`
    : state.status === 'IN_PROGRESS' ? `A practice bot plays ${power} for the rest of the game, and you cannot come back to it.`
    : 'The game stays in its finished state for the others.';
  return <section className="dip-section" aria-labelledby="room-leave">
    <h2 id="room-leave">Leave this game</h2>
    <p className="dip-muted">This browser holds one seat at a time. To create or join another game, leave this one first. {effect}</p>
    {asking ? <div className="dip-orders-actions">
        <button className="dip-solid" onClick={() => { setAsking(false); game.leaveGame(); }}>Leave the game</button>
        <button className="dip-link" onClick={() => setAsking(false)}>Stay</button></div>
      : <div className="dip-orders-actions"><button onClick={() => setAsking(true)}>Leave this game…</button></div>}
  </section>;
}

/** A game started against practice bots: fill every empty seat with one, once, then start it. */
function usePracticeStart(game: GameSocket, hosting: boolean, empty: number) {
  const filled = useRef(false);
  useEffect(() => {
    if (!hosting || sessionStorage.getItem(PRACTICE_START) !== 'pending') return;
    if (empty > 0 && !filled.current) {
      filled.current = true;
      Array.from({ length: empty }).forEach(() => game.addLlmPlayer({ provider: 'STUB', model: PRACTICE_BOT }));
    } else if (empty === 0) {
      sessionStorage.removeItem(PRACTICE_START);
      game.startGame();
    }
  }, [game, hosting, empty]);
}

/** How the host fills seats nobody took. What is offered depends on who is signed in. */
function FillSeats({ game, empty, taken }: { game: GameSocket; empty: number; taken: Power[] }) {
  const auth = useAuth();
  const [power, setPower] = useState<Seat>('RANDOM');
  const [provider, setProvider] = useState<LlmProviderId>('STUB');
  const [model, setModel] = useState(PRACTICE_BOT);
  const [persona, setPersona] = useState('');
  const [realtimeModel, setRealtimeModel] = useState('gpt-realtime-2');
  const [voice, setVoice] = useState('');
  const [voiceInstructions, setVoiceInstructions] = useState('');
  const seat = (to: Seat) => ({ power: to, provider, model, persona: persona || null, realtimeModel, voice: voice.trim() || undefined, voiceInstructions: voiceInstructions || null });

  if (!auth.capabilities.providerSettings) return auth.capabilities.practiceBots
    ? <><p className="dip-muted">Practice bots are the daily challenge’s free opponent: they go for supply centers, back their own attacks and defend their home centers. They use no AI model, send no messages and cost nothing.</p>
        <div className="dip-orders-actions"><button onClick={() => game.addLlmPlayer({ provider: 'STUB', model: PRACTICE_BOT })}>Add one practice bot</button>
          <button onClick={() => Array.from({ length: empty }).forEach(() => game.addLlmPlayer({ provider: 'STUB', model: PRACTICE_BOT }))}>Fill all {empty} with practice bots</button>
          <button className="dip-link" onClick={() => game.addLlmPlayer({ provider: 'STUB', model: 'auto-hold-v0' })}>Add a bot that always holds</button></div></>
    : <p className="dip-muted">Empty seats are filled by people joining with the game code. Adding AI opponents is limited to the site operator, because their model calls are paid for by the server.</p>;

  return <div className="dip-form">
    <p className="dip-muted">Each AI opponent plays one power: it writes its own orders and can negotiate in Messages. Model calls are made with this server’s keys and count against its spending limits.</p>
    <div className="dip-form-grid">
      <label>Power
        <select value={power} onChange={event => setPower(event.target.value as Seat)}>
          <option value="RANDOM">Next free power</option>
          {ALL_POWERS.filter(option => !taken.includes(option)).map(option => <option value={option} key={option}>{title(option)}</option>)}
        </select></label>
      <label>Who plays it
        <select value={provider === 'STUB' ? model : provider} onChange={event => {
          const value = event.target.value, next = (value === PRACTICE_BOT || value === 'auto-hold-v0' ? 'STUB' : value) as LlmProviderId;
          setProvider(next); setModel(next === 'STUB' ? value : DEFAULT_MODEL[next] ?? ''); }}>
          <option value={PRACTICE_BOT}>Practice bot (free, no AI model)</option>
          <option value="auto-hold-v0">Bot that always holds (free)</option>
          <option value="OPENAI">OpenAI model</option>
          <option value="GEMINI">Gemini model</option>
          <option value="OLLAMA">Ollama (a model on this machine)</option>
        </select></label>
      {provider !== 'STUB' && <label>Model{provider === 'OLLAMA' ? ' (blank uses the server’s default)' : ''}
        <input list="room-models" value={model} onChange={event => setModel(event.target.value)} />
        <datalist id="room-models">{(MODEL_SUGGESTIONS[provider] ?? []).map(option => <option value={option} key={option} />)}</datalist></label>}
      {provider !== 'STUB' && <label>Persona (optional)
        <input placeholder="A diplomatic style, e.g. cautious and loyal" value={persona} onChange={event => setPersona(event.target.value)} /></label>}
      {provider !== 'STUB' && auth.capabilities.voice && <>
        <label>Realtime voice model<input value={realtimeModel} onChange={event => setRealtimeModel(event.target.value)} /></label>
        <label>Voice (blank picks one per power)<input placeholder="alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar" value={voice} onChange={event => setVoice(event.target.value)} /></label>
        <label>Spoken style (optional)<textarea rows={2} value={voiceInstructions} onChange={event => setVoiceInstructions(event.target.value)} /></label>
      </>}
    </div>
    <div className="dip-orders-actions">
      <button onClick={() => game.addLlmPlayer(seat(power))}>Add this opponent</button>
      <button onClick={() => Array.from({ length: empty }).forEach(() => game.addLlmPlayer(seat('RANDOM')))}>Fill all {empty} empty seats like this</button>
    </div>
  </div>;
}

/** The host's limits on how AI opponents negotiate with each other, and on voice calls. */
function HostSettings({ game, voice }: { game: GameSocket; voice: boolean }) {
  const settings = game.gameState!.settings;
  const number = (key: 'voiceMaxSessionMinutes' | 'voiceMaxTurns' | 'voiceIdleTimeoutSeconds' | 'voiceAutoCommitSilenceSeconds', label: string, min: number, max: number, step = 1) =>
    <label>{label}<input type="number" min={min} max={max} step={step} value={settings[key]} onChange={event => game.updateGameSettings({ [key]: Number(event.target.value) })} /></label>;
  return <section className="dip-section" aria-labelledby="room-settings">
    <h2 id="room-settings">How AI opponents negotiate</h2>
    <p className="dip-muted">These apply to conversations that AI opponents start themselves. They can be changed until the game starts.</p>
    <div className="dip-form-grid">
      <label>Conversations AI opponents may start each turn
        <select value={settings.llmNegotiationInitiators} onChange={event => game.updateGameSettings({ llmNegotiationInitiators: Number(event.target.value) })}>
          {Array.from({ length: 8 }, (_, count) => <option value={count} key={count}>{count === 0 ? 'None' : count}</option>)}</select></label>
      <label>Longest a conversation can run, in messages
        <select value={settings.llmNegotiationMaxMessages} onChange={event => { const max = Number(event.target.value);
          game.updateGameSettings({ llmNegotiationMaxMessages: max, llmNegotiationWarningAtMessages: Math.min(settings.llmNegotiationWarningAtMessages, max) }); }}>
          {Array.from({ length: 19 }, (_, index) => index + 2).map(count => <option value={count} key={count}>{count}</option>)}</select></label>
      <label>Ask them to wrap up after this many messages
        <select value={settings.llmNegotiationWarningAtMessages} onChange={event => game.updateGameSettings({ llmNegotiationWarningAtMessages: Number(event.target.value) })}>
          {Array.from({ length: settings.llmNegotiationMaxMessages }, (_, index) => index + 1).map(count => <option value={count} key={count}>{count}</option>)}</select></label>
      <label>Cheaper model for opening messages (optional)
        <input placeholder="Blank uses each opponent’s own model" value={settings.llmNegotiationPlannerModel} onChange={event => game.updateGameSettings({ llmNegotiationPlannerModel: event.target.value })} /></label>
    </div>
    <label className="dip-check" style={{ marginTop: 14 }}><input type="checkbox" checked={settings.publicLlmConversationPresence} onChange={event => game.updateGameSettings({ publicLlmConversationPresence: event.target.checked })} />
      Show every player which AI opponents are talking to each other</label>
    <p className="dip-muted dip-small">Off by default, so that who is coordinating stays private.</p>
    {voice && <><h3 style={{ margin: '24px 0 12px' }}>Voice calls</h3><div className="dip-form-grid">
      {number('voiceMaxSessionMinutes', 'Longest call, in minutes', 1, 30)}
      {number('voiceMaxTurns', 'Most turns a person may speak in a call', 1, 50)}
      {number('voiceIdleTimeoutSeconds', 'End a silent call after this many seconds', 15, 300)}
      {number('voiceAutoCommitSilenceSeconds', 'Treat this many seconds of silence as the end of a turn', 1, 10, 0.5)}
    </div></>}
  </section>;
}

function DiscordSection({ game, isHost }: { game: GameSocket; isHost: boolean }) {
  const status = game.discordStatus;
  const code = (label: string, value: { code: string; expiresAt: string }) =>
    <p className="dip-notice">{label} <strong style={{ display: 'inline', letterSpacing: '.08em' }}>{value.code}</strong> <span className="dip-small">· expires {new Date(value.expiresAt).toLocaleTimeString()}</span></p>;
  return <section className="dip-section" aria-labelledby="room-discord">
    <h2 id="room-discord">Discord</h2>
    {!status.configured ? <p className="dip-muted">Discord is not configured on this server.</p> : <>
      <dl className="dip-facts" style={{ marginBottom: 16 }}>
        <div><dt>Discord server</dt><dd>{status.guildBound ? 'Connected to this game' : 'Not connected'}</dd></div>
        <div><dt>Your Discord account</dt><dd>{status.linked ? status.discordDisplayName : 'Not linked'}</dd></div>
      </dl>
      <div className="dip-orders-actions">
        {isHost && !status.guildBound && <button type="button" onClick={game.createDiscordGuildBindCode}>Get a code to connect a Discord server</button>}
        {status.guildBound && !status.linked && <button type="button" onClick={game.createDiscordPlayerLinkCode}>Get a code to link your account</button>}
        <button type="button" className="dip-link" onClick={game.refreshDiscordStatus}>Refresh</button>
      </div>
      {!status.guildBound && game.discordGuildBindCode && code('In Discord, run /game bind with', game.discordGuildBindCode)}
      {!status.linked && game.discordPlayerLinkCode && code('In Discord, run /link with', game.discordPlayerLinkCode)}
    </>}
  </section>;
}

/** Start, steer and end a Discord voice call with another power. */
function VoiceControls({ game, player }: { game: GameSocket; player: Player }) {
  if (!game.capabilities.voice) return null;
  const voice = game.voiceSession, discord = game.discordStatus;
  const active = Boolean(voice.sessionId && voice.power === player.power), ai = player.kind === 'LLM';
  const canStart = discord.configured && discord.voiceEnabled && discord.guildBound && discord.linked && voice.status === 'IDLE'
    && (player.kind === 'HUMAN' || discord.powerBotAvailability[player.power] === true);
  return <span className="dip-voice">
    {!active ? <button type="button" onClick={() => game.startVoiceSession(player.power)} disabled={!canStart}>Start a voice call</button> : <>
      <strong className="dip-small">{voice.status.replace(/_/g, ' ').toLowerCase()}</strong>
      {voice.channelUrl && <a href={voice.channelUrl} target="_blank" rel="noreferrer">Join the call</a>}
      {ai && ['WAITING_FOR_USER', 'READY'].includes(voice.status) && <button type="button" onClick={game.beginVoiceInput}>Start speaking</button>}
      {ai && voice.status === 'LISTENING' && <button type="button" className="dip-solid" onClick={game.commitVoiceInput}>I’m done speaking</button>}
      {ai && ['PROCESSING', 'SPEAKING'].includes(voice.status) && <button type="button" onClick={game.interruptVoiceResponse}>Interrupt</button>}
      <button type="button" onClick={game.endVoiceSession}>End the call</button>
      {ai && voice.error && voice.debug.length > 0 && <details><summary>Voice diagnostics</summary>
        <p className="dip-small">In {voice.inputAudioMs} ms over {voice.receivePackets} packets · out {voice.outputAudioMs} ms</p>
        <ul className="dip-small">{voice.debug.slice(-6).map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}</ul></details>}
    </>}
    {!discord.voiceEnabled && <small>Voice is turned off on this server.</small>}
    {ai && discord.voiceEnabled && discord.powerBotAvailability[player.power] !== true && <small>This power’s voice bot is offline.</small>}
    {active && voice.error && <small style={{ color: 'var(--folio-warning)' }}>{voice.error}</small>}
  </span>;
}
