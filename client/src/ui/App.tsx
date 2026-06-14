import { useEffect, useMemo, useState } from 'react';
import type { Order, TerritoryId, Unit } from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import { useGameSocket } from '../hooks/useGameSocket.js';
import { EventLog } from './EventLog.js';
import { ChatPanel } from './ChatPanel.js';
import { LobbyPanel } from './LobbyPanel.js';
import { MapGraph } from './MapGraph.js';
import { OrderPanel } from './OrderPanel.js';
import { adjacentTerritories, POWER_COLORS, TERRITORY_BY_ID } from '../lib/game.js';

export function App() {
  const game = useGameSocket();
  const [selectedTerritory, setSelectedTerritory] = useState<TerritoryId | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [eventLogOpen, setEventLogOpen] = useState(true);
  const isLobby = !game.gameState || game.gameState.status === 'LOBBY';
  const phaseKey = game.gameState
    ? `${game.gameState.year}-${game.gameState.season}-${game.gameState.phase}`
    : 'no-game';

  useEffect(() => {
    setPendingOrders([]);
  }, [phaseKey]);

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
          {isLobby ? <LobbyPanel game={game} /> : (
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
            </>
          )}
        </aside>

        <section className="panel map-panel">
          <MapGraph
            gameState={game.gameState}
            selectedTerritory={selectedTerritory}
            validTargets={validTargets}
            pendingOrders={pendingOrders}
            onSelectTerritory={selectOnMap}
          />
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
