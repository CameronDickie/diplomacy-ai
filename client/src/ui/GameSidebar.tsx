import { useState } from 'react';
import type { Player, Power, PublicPhaseReport } from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import type { useGameSocket } from '../hooks/useGameSocket.js';
import { POWER_COLORS, territoryLabel } from '../lib/game.js';
import { DiscordPanel } from './DiscordPanel.js';
import { TurnHistoryPanel } from './TurnHistoryPanel.js';

type GameSocket = ReturnType<typeof useGameSocket>;

interface Props {
  game: GameSocket;
  onReplay: (report: PublicPhaseReport) => void;
}

type SidebarTab = 'POWERS' | 'ORDERS' | 'DISCORD';

export function GameSidebar({ game, onReplay }: Props) {
  const [tab, setTab] = useState<SidebarTab>('POWERS');
  const gameState = game.gameState;
  if (!gameState) return null;

  return (
    <>
      <nav className="sidebar-tabs" aria-label="Game sidebar">
        <button
          type="button"
          className={tab === 'POWERS' ? 'selected' : ''}
          onClick={() => setTab('POWERS')}
        >
          Powers
        </button>
        <button
          type="button"
          className={tab === 'ORDERS' ? 'selected' : ''}
          onClick={() => setTab('ORDERS')}
        >
          Orders
        </button>
        <button
          type="button"
          className={tab === 'DISCORD' ? 'selected' : ''}
          onClick={() => setTab('DISCORD')}
        >
          Discord
        </button>
      </nav>

      {tab === 'POWERS' && <PowerList game={game} />}
      {tab === 'ORDERS' && (
        <TurnHistoryPanel
          reports={game.phaseHistory}
          gameState={gameState}
          onReplay={onReplay}
        />
      )}
      {tab === 'DISCORD' && <DiscordPanel game={game} />}
    </>
  );
}

function PowerList({ game }: { game: GameSocket }) {
  const gameState = game.gameState!;
  const activePowers = new Set(
    gameState.units.filter(unit => !unit.mustRetreat).map(unit => unit.power)
  );
  const visibleConversation = game.conversationPresence.participants;

  return (
    <section className="card power-overview-card">
      <h2>Powers</h2>
      <div className="power-accordion">
        {ALL_POWERS.map(power => {
          const player = gameState.players.find(candidate => candidate.power === power);
          const supplyCenters = Object.values(gameState.territories)
            .filter(territory => territory.isSupplyCenter && territory.owner === power)
            .sort((left, right) => left.id.localeCompare(right.id));
          const units = gameState.units.filter(unit => unit.power === power && !unit.mustRetreat);
          const status = powerStatus(
            power,
            gameState.submittedPowers.includes(power),
            activePowers.has(power),
            visibleConversation
          );
          return (
            <details className="power-card" key={power} open={power === game.myPower}>
              <summary>
                <span className={`power-status-dot ${status.className}`} style={{ background: POWER_COLORS[power] }} />
                <strong style={{ color: POWER_COLORS[power] }}>{power}</strong>
                <span>{supplyCenters.length} SC</span>
                <em>{status.label}</em>
              </summary>
              <div className="power-card-body">
                <p>
                  {player
                    ? `${player.name} · ${player.kind === 'HUMAN'
                      ? (player.connected ? 'human online' : 'human offline')
                      : `${player.provider} ${player.model}`}`
                    : 'No player assigned'}
                </p>
                <div className="power-detail-row">
                  <span>Units</span>
                  <strong>{units.length}</strong>
                </div>
                <div className="supply-chip-list">
                  {supplyCenters.length === 0 ? (
                    <em>No controlled supply centers.</em>
                  ) : supplyCenters.map(territory => (
                    <span key={territory.id}>{territoryLabel(territory.id)}</span>
                  ))}
                </div>
                {player && power !== game.myPower && (
                  <PowerVoiceControls game={game} player={player} />
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function powerStatus(
  power: Power,
  submitted: boolean,
  active: boolean,
  visibleConversation: [Power, Power] | null
): { label: string; className: string } {
  if (visibleConversation?.includes(power)) {
    return { label: 'conversing', className: 'conversing' };
  }
  if (!active) return { label: 'inactive', className: 'inactive' };
  if (submitted) return { label: 'submitted', className: 'submitted' };
  return { label: 'pending', className: 'pending' };
}

function PowerVoiceControls({
  game,
  player,
}: {
  game: GameSocket;
  player: Player;
}) {
  const voice = game.voiceSession;
  const activeForPower = voice.sessionId && voice.power === player.power;
  const canStart =
    game.discordStatus.configured &&
    game.discordStatus.voiceEnabled &&
    game.discordStatus.guildBound &&
    game.discordStatus.linked &&
    voice.status === 'IDLE' &&
    (
      player.kind === 'HUMAN' ||
      game.discordStatus.powerBotAvailability[player.power] === true
    );
  const isLlmVoice = player.kind === 'LLM';

  return (
    <div className="power-voice-controls">
      {!activeForPower ? (
        <button
          type="button"
          onClick={() => game.startVoiceSession(player.power)}
          disabled={!canStart}
        >
          Start voice
        </button>
      ) : (
        <>
          <strong>{voice.status.replace(/_/g, ' ').toLowerCase()}</strong>
          {voice.channelUrl && (
            <a href={voice.channelUrl} target="_blank" rel="noreferrer">
              Join
            </a>
          )}
          {isLlmVoice && ['WAITING_FOR_USER', 'READY'].includes(voice.status) && (
            <button type="button" onClick={game.beginVoiceInput}>
              Listen
            </button>
          )}
          {isLlmVoice && voice.status === 'LISTENING' && (
            <button type="button" className="primary" onClick={game.commitVoiceInput}>
              Done
            </button>
          )}
          {isLlmVoice && ['PROCESSING', 'SPEAKING'].includes(voice.status) && (
            <button type="button" onClick={game.interruptVoiceResponse}>
              Interrupt
            </button>
          )}
          <button type="button" onClick={game.endVoiceSession}>End</button>
          {isLlmVoice && (
            <span className="voice-diagnostics">
              in {voice.inputAudioMs}ms/{voice.receivePackets} pkts · out {voice.outputAudioMs}ms
            </span>
          )}
          {isLlmVoice && voice.debug.length > 0 && (
            <details className="voice-debug">
              <summary>Voice diagnostics</summary>
              <ul>
                {voice.debug.slice(-6).map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {!game.discordStatus.voiceEnabled && <em>Voice disabled.</em>}
      {player.kind === 'LLM' &&
        game.discordStatus.voiceEnabled &&
        game.discordStatus.powerBotAvailability[player.power] !== true && (
          <em>Bot offline.</em>
        )}
      {activeForPower && voice.error && <em>{voice.error}</em>}
    </div>
  );
}
