import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type {
  Coast,
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
import { adjacentTerritories, convoyDestinations, convoyRoute, TERRITORY_BY_ID } from '../lib/game.js';

const ignoreMapSelection = () => undefined;

interface MapOrderMenuState {
  territory: TerritoryId;
  x: number;
  y: number;
}

export function App() {
  const game = useGameSocket();
  const [selectedTerritory, setSelectedTerritory] = useState<TerritoryId | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Order[]>([]);
  const [eventLogOpen, setEventLogOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [bottomDockOpen, setBottomDockOpen] = useState(false);
  const [bottomDockHeight, setBottomDockHeight] = useState(300);
  const [seenChatMessages, setSeenChatMessages] = useState(0);
  const [replayReport, setReplayReport] = useState<PublicPhaseReport | null>(null);
  const [replayFrame, setReplayFrame] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [replayRun, setReplayRun] = useState(0);
  const [mapOrderMenu, setMapOrderMenu] = useState<MapOrderMenuState | null>(null);
  const isLobby = !game.gameState || game.gameState.status === 'LOBBY';
  const phaseKey = game.gameState
    ? `${game.gameState.year}-${game.gameState.season}-${game.gameState.phase}`
    : 'no-game';
  const unreadChatMessages = Math.max(
    0,
    game.diplomaticMessages.length - seenChatMessages
  );
  const isHost = Boolean(game.gameState && game.gameState.hostPlayerId === game.myPlayerId);
  const hostEventLogOpen = isHost && eventLogOpen;

  useEffect(() => {
    setPendingOrders([]);
    setMapOrderMenu(null);
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

  useEffect(() => {
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMapOrderMenu(null);
    };
    window.addEventListener('keydown', closeMenu);
    return () => window.removeEventListener('keydown', closeMenu);
  }, []);

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
    return game.gameState.units.find(
      unit => unit.territory === selectedTerritory && unit.power === game.myPower && !unit.mustRetreat
    ) ?? null;
  }, [game.gameState, game.myPower, selectedTerritory]);
  const selectedUnitConvoyOrder = useMemo(
    () => selectedUnit
      ? pendingOrders.find(order => order.unitTerritory === selectedUnit.territory && order.type === 'CONVOY') ?? null
      : null,
    [pendingOrders, selectedUnit]
  );
  const directTargets = useMemo(
    () => selectedUnit && selectedUnit.power === game.myPower && !selectedUnitConvoyOrder
      ? adjacentTerritories(selectedUnit)
      : [],
    [game.myPower, selectedUnit, selectedUnitConvoyOrder]
  );
  const convoyTargets = useMemo(
    () => selectedUnit && game.gameState && !selectedUnitConvoyOrder
      ? convoyDestinations(selectedUnit, game.gameState.units)
      : [],
    [game.gameState, selectedUnit, selectedUnitConvoyOrder]
  );
  const mapTargets = useMemo(
    () => [...new Set([...directTargets, ...convoyTargets])],
    [convoyTargets, directTargets]
  );

  function selectOnMap(territory: TerritoryId, point?: { x: number; y: number }) {
    const clickedUnit = game.gameState?.units.find(
      unit => unit.territory === territory && !unit.mustRetreat
    );
    const clickedOwnUnit = game.gameState?.units.find(
      unit => unit.territory === territory && unit.power === game.myPower && !unit.mustRetreat
    );
    if (clickedOwnUnit && clickedOwnUnit.id !== selectedUnit?.id) {
      setSelectedTerritory(territory);
      setMapOrderMenu(null);
      return;
    }
    if (
      selectedUnit &&
      selectedUnit.power === game.myPower &&
      game.gameState?.phase === 'ORDERS'
    ) {
      setMapOrderMenu({
        territory,
        x: point?.x ?? window.innerWidth / 2,
        y: point?.y ?? window.innerHeight / 2,
      });
      return;
    }
    if (clickedUnit && clickedUnit.power !== game.myPower) {
      setMapOrderMenu(null);
      return;
    }
    setSelectedTerritory(territory);
    setMapOrderMenu(null);
  }

  function submitOrders() {
    game.submitOrders(pendingOrders);
  }

  function clearMapSelection() {
    setSelectedTerritory(null);
    setMapOrderMenu(null);
  }

  function queueMapOrder(order: Order) {
    queueMapOrders([order]);
  }

  function queueMapOrders(nextOrders: Order[]) {
    const orderedTerritories = new Set(nextOrders.map(order => order.unitTerritory));
    setPendingOrders(orders => [
      ...orders.filter(candidate => !orderedTerritories.has(candidate.unitTerritory)),
      ...nextOrders,
    ]);
    setMapOrderMenu(null);
  }

  function buildHoldOrder(unit: Unit): Order {
    return {
      id: crypto.randomUUID(),
      power: unit.power,
      unitTerritory: unit.territory,
      unitCoast: unit.coast,
      type: 'HOLD',
      targetTerritory: null,
      targetCoast: null,
      supportedUnit: null,
      supportedDestination: null,
    };
  }

  function buildMoveOrder(
    unit: Unit,
    territory: TerritoryId,
    coast: Coast | null,
    viaConvoy?: boolean
  ): Order {
    return {
      id: crypto.randomUUID(),
      power: unit.power,
      unitTerritory: unit.territory,
      unitCoast: unit.coast,
      type: 'MOVE',
      targetTerritory: territory,
      targetCoast: coast,
      viaConvoy,
      supportedUnit: null,
      supportedDestination: null,
    };
  }

  function buildConvoyOrder(fleet: Unit, army: Unit, destination: TerritoryId): Order {
    return {
      id: crypto.randomUUID(),
      power: fleet.power,
      unitTerritory: fleet.territory,
      unitCoast: fleet.coast,
      type: 'CONVOY',
      targetTerritory: destination,
      targetCoast: null,
      supportedUnit: army.territory,
      supportedDestination: null,
    };
  }

  function queueConvoyMove(unit: Unit, territory: TerritoryId) {
    const route = game.gameState ? convoyRoute(unit, game.gameState.units, territory) : [];
    if (route.length === 0) return;
    queueMapOrders([
      buildMoveOrder(unit, territory, null, true),
      ...route.map(fleet => buildConvoyOrder(fleet, unit, territory)),
    ]);
  }

  function startBottomDockResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bottomDockHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = Math.min(
        Math.max(180, startHeight + startY - moveEvent.clientY),
        Math.max(220, window.innerHeight - 220)
      );
      setBottomDockHeight(nextHeight);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div
      className={`app-shell ${bottomDockOpen ? '' : 'bottom-dock-collapsed'}`}
      style={{ '--bottom-dock-height': `${bottomDockHeight}px` } as CSSProperties}
    >
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
            selectedUnit={replayReport ? null : selectedUnit}
            validTargets={replayReport ? [] : mapTargets}
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
            onClearSelection={clearMapSelection}
          />
          {mapOrderMenu && selectedUnit && game.gameState?.phase === 'ORDERS' && (
            <MapOrderMenu
              menu={mapOrderMenu}
              selectedUnit={selectedUnit}
              directTargets={directTargets}
              convoyTargets={convoyTargets}
              occupiedUnit={game.gameState.units.find(
                unit => unit.territory === mapOrderMenu.territory && !unit.mustRetreat
              ) ?? null}
              lockedConvoyOrder={selectedUnitConvoyOrder}
              onClose={() => setMapOrderMenu(null)}
              onHold={() => queueMapOrder(buildHoldOrder(selectedUnit))}
              onMove={coast => queueMapOrder(buildMoveOrder(selectedUnit, mapOrderMenu.territory, coast))}
              onConvoyMove={() => queueConvoyMove(selectedUnit, mapOrderMenu.territory)}
            />
          )}
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

      <section className={`bottom-dock ${bottomDockOpen ? '' : 'dock-collapsed'} ${hostEventLogOpen ? '' : 'log-collapsed'} ${chatOpen ? '' : 'chat-hidden'}`}>
        {bottomDockOpen ? (
          <>
            <div
              className="bottom-dock-resizer"
              onPointerDown={startBottomDockResize}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize diplomacy panel"
            />
            <div className="bottom-dock-toolbar">
              <button type="button" onClick={() => setBottomDockOpen(false)}>
                Hide {isHost ? 'diplomacy/logs' : 'diplomacy'}
              </button>
              <button
                type="button"
                className={chatOpen ? 'selected' : ''}
                onClick={() => setChatOpen(open => !open)}
              >
                Diplomacy
                {unreadChatMessages > 0 && <strong>{unreadChatMessages}</strong>}
              </button>
              {isHost && (
                <button
                  type="button"
                  className={eventLogOpen ? 'selected' : ''}
                  onClick={() => setEventLogOpen(open => !open)}
                >
                  Event log
                </button>
              )}
            </div>
            {chatOpen && (
              <div className="chat-dock">
                <ChatPanel game={game} />
              </div>
            )}
            {hostEventLogOpen && (
              <EventLog
                entries={game.logs}
                open={hostEventLogOpen}
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
            Open {isHost ? 'diplomacy and logs' : 'diplomacy'}
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

function MapOrderMenu({
  menu,
  selectedUnit,
  directTargets,
  convoyTargets,
  occupiedUnit,
  lockedConvoyOrder,
  onClose,
  onHold,
  onMove,
  onConvoyMove,
}: {
  menu: MapOrderMenuState;
  selectedUnit: Unit;
  directTargets: TerritoryId[];
  convoyTargets: TerritoryId[];
  occupiedUnit: Unit | null;
  lockedConvoyOrder: Order | null;
  onClose: () => void;
  onHold: () => void;
  onMove: (coast: Coast | null) => void;
  onConvoyMove: () => void;
}) {
  const lockedByConvoy = Boolean(lockedConvoyOrder);
  const canHold = !lockedByConvoy && menu.territory === selectedUnit.territory;
  const canMove = !lockedByConvoy && directTargets.includes(menu.territory);
  const canConvoyMove = !lockedByConvoy && convoyTargets.includes(menu.territory);
  const target = TERRITORY_BY_ID[menu.territory];
  const moveCoasts =
    canMove && selectedUnit.type === 'FLEET'
      ? target?.coasts ?? []
      : [];
  const blockedByOwnUnit = Boolean(
    occupiedUnit &&
    occupiedUnit.power === selectedUnit.power &&
    occupiedUnit.id !== selectedUnit.id
  );

  return (
    <div
      className="map-order-menu"
      style={{
        left: Math.min(menu.x + 10, window.innerWidth - 230),
        top: Math.min(menu.y + 10, window.innerHeight - 190),
      }}
    >
      <header>
        <strong>{selectedUnit.type} {selectedUnit.territory}</strong>
        <button type="button" onClick={onClose} aria-label="Close order menu">x</button>
      </header>
      <p>{target?.name ?? menu.territory}</p>
      <div>
        {lockedConvoyOrder && (
          <em>
            Fleet committed to convoy {lockedConvoyOrder.supportedUnit} to {lockedConvoyOrder.targetTerritory}.
          </em>
        )}
        {canHold && (
          <button type="button" onClick={onHold}>
            Hold
          </button>
        )}
        {canMove && !blockedByOwnUnit && moveCoasts.length === 0 && (
          <button type="button" onClick={() => onMove(null)}>
            Move
          </button>
        )}
        {canMove && !blockedByOwnUnit && moveCoasts.length > 0 && moveCoasts.map(coast => (
          <button type="button" onClick={() => onMove(coast)} key={coast}>
            Move {coast.toLowerCase()} coast
          </button>
        ))}
        {canConvoyMove && !blockedByOwnUnit && (
          <button type="button" onClick={onConvoyMove}>
            Move via convoy
          </button>
        )}
        {blockedByOwnUnit && <em>Own unit occupies this province.</em>}
        {!canHold && !canMove && !canConvoyMove && <em>No direct order available.</em>}
      </div>
    </div>
  );
}
