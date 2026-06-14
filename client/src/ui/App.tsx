import { useMemo, useState } from 'react';
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
    setPendingOrders([]);
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
          <LobbyPanel game={game} />
          {game.gameState && (
            <section className="card">
              <h2>Supply</h2>
              {ALL_POWERS.map(power => {
                const count = Object.values(game.gameState!.territories).filter(
                  territory => territory.isSupplyCenter && territory.owner === power
                ).length;
                return (
                  <div className="stat-row" key={power}>
                    <span style={{ color: POWER_COLORS[power] }}>{power}</span>
                    <strong>{count}</strong>
                  </div>
                );
              })}
            </section>
          )}
        </aside>

        <section className="panel map-panel">
          <MapGraph
            gameState={game.gameState}
            selectedTerritory={selectedTerritory}
            validTargets={validTargets}
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

      <section className="bottom-dock">
        <ChatPanel game={game} />
        <EventLog entries={game.logs} />
      </section>
    </div>
  );
}
