import { useEffect, useMemo, useState } from 'react';
import type {
  GameState,
  Order,
  PublicBoardSnapshot,
  PublicPhaseReport,
  TerritoryId,
  Unit,
} from '@diplomacy/shared';
import { useGameSocket } from '../hooks/useGameSocket.js';
import { EventLog } from './EventLog.js';
import { ChatPanel } from './ChatPanel.js';
import { LobbyPanel } from './LobbyPanel.js';
import { MapGraph } from './MapGraph.js';
import { OrderPanel } from './OrderPanel.js';
import { ReplayControls } from './ReplayControls.js';
import { DiscordPanel } from './DiscordPanel.js';
import { GameSidebar } from './GameSidebar.js';
import { adjacentTerritories, TERRITORY_BY_ID } from '../lib/game.js';

const ignoreMapSelection = () => undefined;

export function App() {
  const game = useGameSocket();
  const [selectedTerritory, setSelectedTerritory] = useState<TerritoryId | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [eventLogOpen, setEventLogOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [bottomDockOpen, setBottomDockOpen] = useState(false);
  const [seenChatMessages, setSeenChatMessages] = useState(0);
  const [replayReport, setReplayReport] = useState<PublicPhaseReport | null>(null);
  const [replayFrame, setReplayFrame] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replayRun, setReplayRun] = useState(0);
  const isLobby = !game.gameState || game.gameState.status === 'LOBBY';
  const phaseKey = game.gameState
    ? `${game.gameState.year}-${game.gameState.season}-${game.gameState.phase}`
    : 'no-game';
  const unreadChatMessages = Math.max(
    0,
    game.diplomaticMessages.length - seenChatMessages
  );

  useEffect(() => {
    setPendingOrders([]);
  }, [phaseKey]);

  useEffect(() => {
    if (chatOpen) setSeenChatMessages(game.diplomaticMessages.length);
  }, [chatOpen, game.diplomaticMessages.length]);

  useEffect(() => {
    if (!replayReport || !replayPlaying) return;
    if (replayFrame >= 2) {
      setReplayPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => setReplayFrame(frame => Math.min(2, frame + 1)),
      1400 / replaySpeed
    );
    return () => window.clearTimeout(timer);
  }, [replayFrame, replayPlaying, replayReport, replaySpeed]);

  const displayedGameState = useMemo(() => {
    if (!game.gameState || !replayReport) return game.gameState;
    const snapshot = replayFrame < 2 ? replayReport.before : replayReport.after;
    return gameStateFromSnapshot(game.gameState, replayReport, snapshot);
  }, [game.gameState, replayFrame, replayReport]);
  const displayedOrders =
    replayReport?.phase === 'ORDERS' && replayFrame === 1
      ? replayReport.resolvedOrders
      : replayReport ? [] : pendingOrders;

  const selectedUnit = useMemo<Unit | null>(() => {
    if (!selectedTerritory || !game.gameState) return null;
    return game.gameState.units.find(unit => unit.territory === selectedTerritory) ?? null;
  }, [game.gameState, selectedTerritory]);
  const validTargets = useMemo(
    () => selectedUnit && selectedUnit.power === game.myPower ? adjacentTerritories(selectedUnit) : [],
    [game.myPower, selectedUnit]
  );

  function selectOnMap(territory: TerritoryId) {
    if (
      selectedUnit &&
      selectedUnit.power === game.myPower &&
      game.gameState?.phase === 'ORDERS' &&
      validTargets.includes(territory)
    ) {
      if (
        selectedUnit.type === 'FLEET' &&
        (TERRITORY_BY_ID[territory]?.coasts.length ?? 0) > 1
      ) {
        return;
      }
      const move: Order = {
        id: crypto.randomUUID(),
        power: selectedUnit.power,
        unitTerritory: selectedUnit.territory,
        unitCoast: selectedUnit.coast,
        type: 'MOVE',
        targetTerritory: territory,
        targetCoast: null,
        supportedUnit: null,
        supportedDestination: null,
      };
      setPendingOrders(orders => [
        ...orders.filter(order => order.unitTerritory !== selectedUnit.territory),
        move,
      ]);
      return;
    }
    setSelectedTerritory(territory);
  }

  function submitOrders() {
    game.submitOrders(pendingOrders);
  }

  return (
    <div className={`app-shell ${bottomDockOpen ? '' : 'bottom-dock-collapsed'}`}>
      <header className="topbar">
        <div>
          <h1>Diplomacy</h1>
          <p>Multiplayer engine, React client, LLM-ready seats</p>
        </div>
        <span className={`connection ${game.connection}`}>{game.connection}</span>
        {game.gameState && (
          <span className="phase-pill">
            {game.gameState.year} {game.gameState.season} {game.gameState.phase}
          </span>
        )}
        {game.gameId && <span className="game-code">Game {game.gameId}</span>}
      </header>

      <main className="workspace">
        <aside className="panel side-panel">
          {isLobby ? (
            <>
              <LobbyPanel game={game} />
              <DiscordPanel game={game} />
            </>
          ) : (
            <GameSidebar
              game={game}
              onReplay={report => {
                setReplayReport(report);
                setReplayFrame(0);
                setReplayPlaying(true);
                setReplayRun(run => run + 1);
              }}
            />
          )}
        </aside>

        <section className="panel map-panel">
          <MapGraph
            gameState={displayedGameState}
            selectedTerritory={replayReport ? null : selectedTerritory}
            validTargets={replayReport ? [] : validTargets}
            pendingOrders={displayedOrders}
            replayStandoffs={
              replayReport?.phase === 'ORDERS' && replayFrame === 2
                ? replayReport.standoffTerritories
                : []
            }
            unitAnimationFrom={
              replayReport && replayFrame === 2
                ? replayReport.before.units
                : undefined
            }
            unitAnimationKey={
              replayReport && replayFrame === 2
                ? `${replayReport.id}-${replayRun}`
                : null
            }
            onSelectTerritory={replayReport ? ignoreMapSelection : selectOnMap}
          />
          {replayReport && (
            <ReplayControls
              report={replayReport}
              frame={replayFrame}
              playing={replayPlaying}
              speed={replaySpeed}
              onFrameChange={frame => {
                setReplayFrame(frame);
                setReplayPlaying(false);
              }}
              onPlayingChange={playing => {
                if (playing && replayFrame === 2) {
                  setReplayFrame(0);
                  setReplayRun(run => run + 1);
                }
                setReplayPlaying(playing);
              }}
              onSpeedChange={setReplaySpeed}
              onClose={() => {
                setReplayReport(null);
                setReplayPlaying(false);
              }}
            />
          )}
        </section>

        <aside className="panel orders-panel">
          <OrderPanel
            gameState={game.gameState}
            myPower={game.myPower}
            selectedUnit={selectedUnit}
            pendingOrders={pendingOrders}
            onSelectTerritory={setSelectedTerritory}
            onPendingOrdersChange={setPendingOrders}
            onSubmitOrders={submitOrders}
            onSubmitRetreats={game.submitRetreats}
            onSubmitBuilds={game.submitBuilds}
          />
        </aside>
      </main>

      <section className={`bottom-dock ${bottomDockOpen ? '' : 'dock-collapsed'} ${eventLogOpen ? '' : 'log-collapsed'} ${chatOpen ? '' : 'chat-hidden'}`}>
        {bottomDockOpen ? (
          <>
            <div className="bottom-dock-toolbar">
              <button type="button" onClick={() => setBottomDockOpen(false)}>
                Hide diplomacy/logs
              </button>
              <button
                type="button"
                className={chatOpen ? 'selected' : ''}
                onClick={() => setChatOpen(open => !open)}
              >
                Diplomacy
                {unreadChatMessages > 0 && <strong>{unreadChatMessages}</strong>}
              </button>
              <button
                type="button"
                className={eventLogOpen ? 'selected' : ''}
                onClick={() => setEventLogOpen(open => !open)}
              >
                Event log
              </button>
            </div>
            {chatOpen && (
              <div className="chat-dock">
                <ChatPanel game={game} />
              </div>
            )}
            {eventLogOpen && (
              <EventLog
                entries={game.logs}
                open={eventLogOpen}
                onToggle={() => setEventLogOpen(open => !open)}
              />
            )}
          </>
        ) : (
          <button
            type="button"
            className="bottom-dock-restore"
            onClick={() => setBottomDockOpen(true)}
          >
            Open diplomacy and logs
            {unreadChatMessages > 0 && <strong>{unreadChatMessages}</strong>}
          </button>
        )}
      </section>
    </div>
  );
}

function gameStateFromSnapshot(
  liveState: GameState,
  report: PublicPhaseReport,
  snapshot: PublicBoardSnapshot
): GameState {
  return {
    ...liveState,
    year: report.year,
    season: report.season,
    phase: report.phase,
    units: structuredClone(snapshot.units),
    territories: Object.fromEntries(
      Object.entries(liveState.territories).map(([territory, state]) => [
        territory,
        {
          ...state,
          owner: snapshot.territoryOwners[territory],
        },
      ])
    ),
  };
}
