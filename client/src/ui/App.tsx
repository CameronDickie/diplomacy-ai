import { useEffect, useMemo, useState } from 'react';
import type {
  GameState,
  Order,
  PublicBoardSnapshot,
  PublicPhaseReport,
  TerritoryId,
  Unit,
} from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import { useGameSocket } from '../hooks/useGameSocket.js';
import { EventLog } from './EventLog.js';
import { ChatPanel } from './ChatPanel.js';
import { LobbyPanel } from './LobbyPanel.js';
import { MapGraph } from './MapGraph.js';
import { OrderPanel } from './OrderPanel.js';
import { TurnHistoryPanel } from './TurnHistoryPanel.js';
import { ReplayControls } from './ReplayControls.js';
import { DiscordPanel } from './DiscordPanel.js';
import { adjacentTerritories, POWER_COLORS, TERRITORY_BY_ID } from '../lib/game.js';

const ignoreMapSelection = () => undefined;

export function App() {
  const game = useGameSocket();
  const [selectedTerritory, setSelectedTerritory] = useState<TerritoryId | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [eventLogOpen, setEventLogOpen] = useState(true);
  const [replayReport, setReplayReport] = useState<PublicPhaseReport | null>(null);
  const [replayFrame, setReplayFrame] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replayRun, setReplayRun] = useState(0);
  const isLobby = !game.gameState || game.gameState.status === 'LOBBY';
  const phaseKey = game.gameState
    ? `${game.gameState.year}-${game.gameState.season}-${game.gameState.phase}`
    : 'no-game';

  useEffect(() => {
    setPendingOrders([]);
  }, [phaseKey]);

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
    <div className="app-shell">
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
            <>
              <section className="card supply-card">
                <h2>Supply Centers</h2>
                {ALL_POWERS.map(power => {
                  const count = Object.values(game.gameState!.territories).filter(
                    territory => territory.isSupplyCenter && territory.owner === power
                  ).length;
                  return (
                    <div className="supply-row" key={power}>
                      <span className="power-swatch" style={{ background: POWER_COLORS[power] }} />
                      <strong style={{ color: POWER_COLORS[power] }}>{power}</strong>
                      <b>{count}</b>
                    </div>
                  );
                })}
              </section>
              <section className="card">
                <h2>Players</h2>
                <div className="player-list">
                  {game.gameState!.players.map(player => (
                    <div className="player-row compact" key={player.id}>
                      <strong>{player.power}</strong>
                      <span>{player.name}</span>
                      <em>
                        {player.kind === 'HUMAN'
                          ? (player.connected ? 'online' : 'offline')
                          : `${player.provider} ${player.model}`}
                      </em>
                    </div>
                  ))}
                </div>
              </section>
              <DiscordPanel game={game} />
              <TurnHistoryPanel
                reports={game.phaseHistory}
                gameState={game.gameState!}
                onReplay={report => {
                  setReplayReport(report);
                  setReplayFrame(0);
                  setReplayPlaying(true);
                  setReplayRun(run => run + 1);
                }}
              />
            </>
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

      <section className={`bottom-dock ${eventLogOpen ? '' : 'log-collapsed'}`}>
        <ChatPanel game={game} />
        <EventLog
          entries={game.logs}
          open={eventLogOpen}
          onToggle={() => setEventLogOpen(open => !open)}
        />
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
