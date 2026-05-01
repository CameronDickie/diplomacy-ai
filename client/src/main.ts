import { io, Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  GameState,
  Power,
  Unit,
  Order,
  OrderType,
} from '@diplomacy/shared';
import { ADJACENCY, TERRITORIES } from '@diplomacy/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// ── State ─────────────────────────────────────────────────────────────────────

let socket: AppSocket | null = null;
let gameState: GameState | null = null;
let myPower: Power | null = null;
let gameId: string | null = null;
let selectedUnit: Unit | null = null;
let pendingOrders: Order[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

const TERRITORY_NAMES: Record<string, string> = Object.fromEntries(
  TERRITORIES.map(t => [t.id, t.name])
);

function territoryLabel(id: string): string {
  return TERRITORY_NAMES[id] ? `${id} — ${TERRITORY_NAMES[id]}` : id;
}

function adjacentTerritories(unit: Unit): string[] {
  const entry = ADJACENCY[unit.territory];
  if (!entry) return [];
  if (unit.type === 'ARMY') {
    return entry.army as string[];
  }
  // Fleet: handle multi-coast
  const fleet = entry.fleet;
  if (Array.isArray(fleet)) return fleet as string[];
  // multi-coast: use the unit's coast, or union all coasts
  if (unit.coast) return (fleet as Record<string, string[]>)[unit.coast] ?? [];
  return Object.values(fleet as Record<string, string[]>).flat();
}

function makeOrderId(): string {
  return `order-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function ts(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(
  direction: 'incoming' | 'outgoing' | 'system' | 'errored',
  event: string,
  data: unknown = ''
) {
  const container = document.getElementById('log-entries')!;
  const entry = document.createElement('div');
  entry.className = `log-entry ${direction}`;
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  entry.innerHTML = `
    <span class="log-ts">${ts()}</span>
    <span class="log-event">${event}</span>
    <span class="log-data" title="${dataStr.replace(/"/g, '&quot;')}">${dataStr}</span>
  `;
  container.prepend(entry);
}

// ── Socket setup ──────────────────────────────────────────────────────────────

function connect() {
  if (socket?.connected) return;

  socket = io('http://localhost:3001', { transports: ['websocket'] }) as AppSocket;

  socket.on('connect', () => {
    setStatus('connected', `socket ${socket!.id}`);
    log('system', 'connect', socket!.id);
  });

  socket.on('disconnect', reason => {
    setStatus('disconnected', reason);
    log('system', 'disconnect', reason);
  });

  socket.on('connect_error', err => {
    setStatus('error', err.message);
    log('errored', 'connect_error', err.message);
  });

  // ── Server events ────────────────────────────────────────────────────────

  socket.on('game_created', payload => {
    log('incoming', 'game_created', { gameId: payload.gameId, power: payload.power });
    gameId = payload.gameId;
    myPower = payload.power;
    applyState(payload.gameState);
    showGameSection();
    document.getElementById('game-id-display')!.textContent = `Game: ${gameId}`;
  });

  socket.on('game_joined', payload => {
    log('incoming', 'game_joined', { power: payload.power });
    myPower = payload.power;
    applyState(payload.gameState);
    showGameSection();
    document.getElementById('game-id-display')!.textContent = `Game: ${gameId}`;
  });

  socket.on('join_error', payload => {
    log('errored', 'join_error', payload);
    alert(`Join error: ${payload.message}`);
  });

  socket.on('player_joined', payload => {
    log('incoming', 'player_joined', { name: payload.player.name, power: payload.player.power });
    if (gameState) {
      gameState.players = payload.allPlayers;
      renderPlayers();
    }
  });

  socket.on('player_disconnected', payload => {
    log('incoming', 'player_disconnected', payload);
    if (gameState) {
      const p = gameState.players.find(pl => pl.power === payload.power);
      if (p) { p.connected = false; renderPlayers(); }
    }
  });

  socket.on('game_state_sync', payload => {
    log('incoming', 'game_state_sync', `year=${payload.gameState.year} season=${payload.gameState.season} phase=${payload.gameState.phase}`);
    applyState(payload.gameState);
  });

  socket.on('orders_acknowledged', payload => {
    log('incoming', 'orders_acknowledged', `${payload.orders.length} orders acknowledged`);
    pendingOrders = [];
    renderPendingOrders();
    (document.getElementById('btn-submit-orders') as HTMLButtonElement).disabled = true;
  });

  socket.on('power_submitted', payload => {
    log('incoming', 'power_submitted', `${payload.power} (${payload.totalSubmitted}/${payload.totalRequired})`);
    document.getElementById('info-submitted')!.textContent =
      `${payload.totalSubmitted} / ${payload.totalRequired}`;
  });

  socket.on('turn_resolved', payload => {
    log('incoming', 'turn_resolved', `${payload.adjudicationResult.resolvedOrders.length} orders resolved`);
    applyState(payload.newGameState);
    pendingOrders = [];
    renderPendingOrders();
    selectedUnit = null;
    renderOrderForm();
    // Brief summary in log
    const result = payload.adjudicationResult;
    if (result.dislodgedUnits.length)
      log('system', '  dislodged', result.dislodgedUnits.map(u => `${u.power}@${u.territory}`).join(', '));
    if (result.standoffTerritories.length)
      log('system', '  standoffs', result.standoffTerritories.join(', '));
  });

  socket.on('retreat_phase_start', payload => {
    log('incoming', 'retreat_phase_start', `${payload.allDislodged.length} units must retreat`);
    applyState(payload.gameState);
    // TODO: retreat UI
  });

  socket.on('build_phase_start', payload => {
    log('incoming', 'build_phase_start', JSON.stringify(payload.buildCounts));
    applyState(payload.gameState);
    // TODO: build UI
  });

  socket.on('game_over', payload => {
    log('incoming', 'game_over', `Winner: ${payload.winner}`);
    alert(`Game over! Winner: ${payload.winner}`);
    applyState(payload.gameState);
  });

  socket.on('error', payload => {
    log('errored', 'error', payload);
  });
}

// ── State rendering ───────────────────────────────────────────────────────────

function applyState(state: GameState) {
  gameState = state;
  renderGameInfo();
  renderPlayers();
  renderSupply();
  renderUnits();
  renderOrderForm();
  updatePhaseBadge();
}

function updatePhaseBadge() {
  if (!gameState) return;
  const badge = document.getElementById('phase-badge')!;
  badge.style.display = 'inline';
  badge.textContent = `${gameState.year} ${gameState.season} — ${gameState.phase}`;
  badge.className = `phase-badge ${gameState.phase.toLowerCase()}`;
  badge.id = 'phase-badge'; // keep id
}

function renderGameInfo() {
  if (!gameState) return;
  document.getElementById('info-year')!.textContent = String(gameState.year);
  document.getElementById('info-season')!.textContent = gameState.season;
  document.getElementById('info-phase')!.textContent = gameState.phase;
  document.getElementById('info-power')!.textContent = myPower ?? '—';
  document.getElementById('info-submitted')!.textContent =
    `${gameState.submittedPowers.length} / ${gameState.players.length}`;
}

function renderPlayers() {
  if (!gameState) return;
  const list = document.getElementById('player-list')!;
  list.innerHTML = gameState.players.map(p => `
    <div class="player-entry">
      <span><span class="dot ${p.connected ? 'online' : 'offline'}"></span>${p.name}</span>
      <span class="power-tag" style="${powerColor(p.power)}">${p.power}</span>
    </div>
  `).join('');
}

function renderSupply() {
  if (!gameState) return;
  const counts: Record<string, number> = {};
  for (const ts of Object.values(gameState.territories)) {
    if (ts.owner && ts.isSupplyCenter) {
      counts[ts.owner] = (counts[ts.owner] ?? 0) + 1;
    }
  }
  const list = document.getElementById('supply-list')!;
  list.innerHTML = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([power, count]) => `
      <div class="stat-row">
        <span class="stat-label" style="${powerColor(power as Power)}">${power}</span>
        <span class="stat-value">${count} SC</span>
      </div>
    `).join('');
}

function renderUnits() {
  if (!gameState) return;
  const list = document.getElementById('unit-list')!;
  const myUnits = gameState.units.filter(u => u.power === myPower);
  document.getElementById('unit-count')!.textContent =
    myUnits.length ? `(${myUnits.length})` : '';

  if (!myUnits.length) {
    list.innerHTML = '<div style="color:#555; font-size:11px">No units</div>';
    return;
  }

  list.innerHTML = myUnits.map(u => `
    <div class="unit-entry ${selectedUnit?.id === u.id ? 'selected' : ''} ${u.mustRetreat ? 'must-retreat' : ''}"
         data-unit-id="${u.id}">
      <span class="unit-type">${u.type === 'ARMY' ? 'A' : 'F'}</span>
      <span class="unit-territory">${u.territory}${u.coast ? ` (${u.coast[0]})` : ''}</span>
      ${u.mustRetreat ? '<span style="color:#e05050;font-size:10px">RETREAT</span>' : ''}
    </div>
  `).join('');

  list.querySelectorAll('.unit-entry').forEach(el => {
    el.addEventListener('click', () => {
      const uid = (el as HTMLElement).dataset.unitId!;
      const unit = gameState!.units.find(u => u.id === uid) ?? null;
      selectedUnit = selectedUnit?.id === uid ? null : unit;
      renderUnits();
      renderOrderForm();
    });
  });
}

function renderOrderForm() {
  const wrap = document.getElementById('order-form-wrap')!;
  if (!selectedUnit || !gameState || gameState.phase !== 'ORDERS') {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';

  const unit = selectedUnit;
  document.getElementById('order-unit-label')!.textContent =
    `${unit.type === 'ARMY' ? 'Army' : 'Fleet'} ${unit.territory}`;

  const orderType = (document.getElementById('select-order-type') as HTMLSelectElement).value as OrderType;
  const adj = adjacentTerritories(unit);

  // Target territory (for MOVE / SUPPORT_HOLD / etc.)
  const selTarget = document.getElementById('select-target') as HTMLSelectElement;
  const selSupportUnit = document.getElementById('select-support-unit') as HTMLSelectElement;
  const selSupportDest = document.getElementById('select-support-dest') as HTMLSelectElement;

  selTarget.style.display = 'none';
  selSupportUnit.style.display = 'none';
  selSupportDest.style.display = 'none';

  if (orderType === 'MOVE' || orderType === 'CONVOY') {
    selTarget.style.display = 'block';
    if (!selTarget.dataset.populated) {
      selTarget.innerHTML = '<option value="">— target territory —</option>' +
        adj.map(id => `<option value="${id}">${id} — ${TERRITORY_NAMES[id] ?? id}</option>`).join('');
      selTarget.dataset.populated = '1';
    }
  } else if (orderType === 'SUPPORT_HOLD' || orderType === 'SUPPORT_MOVE') {
    selSupportUnit.style.display = 'block';
    if (gameState) {
      const otherUnits = gameState.units.filter(u => u.id !== unit.id);
      selSupportUnit.innerHTML = '<option value="">— unit to support —</option>' +
        otherUnits.map(u => `<option value="${u.territory}">${u.power} ${u.type === 'ARMY' ? 'A' : 'F'} ${u.territory}</option>`).join('');
    }
    if (orderType === 'SUPPORT_MOVE') {
      selSupportDest.style.display = 'block';
      selSupportDest.innerHTML = '<option value="">— support destination —</option>' +
        adj.map(id => `<option value="${id}">${id}</option>`).join('');
    }
  }
}

function renderPendingOrders() {
  const list = document.getElementById('pending-order-list')!;
  if (!pendingOrders.length) {
    list.innerHTML = '<div style="color:#555;font-size:11px">None</div>';
    (document.getElementById('btn-submit-orders') as HTMLButtonElement).disabled = true;
    return;
  }
  list.innerHTML = pendingOrders.map((o, i) => `
    <div class="order-tag">
      <span>${formatOrder(o)}</span>
      <span class="remove" data-idx="${i}">✕</span>
    </div>
  `).join('');
  list.querySelectorAll('.remove').forEach(el => {
    el.addEventListener('click', () => {
      pendingOrders.splice(Number((el as HTMLElement).dataset.idx), 1);
      renderPendingOrders();
    });
  });
  (document.getElementById('btn-submit-orders') as HTMLButtonElement).disabled = false;
}

function formatOrder(o: Order): string {
  switch (o.type) {
    case 'HOLD':         return `${o.unitTerritory} HOLD`;
    case 'MOVE':         return `${o.unitTerritory} → ${o.targetTerritory}`;
    case 'SUPPORT_HOLD': return `${o.unitTerritory} S ${o.supportedUnit} HOLD`;
    case 'SUPPORT_MOVE': return `${o.unitTerritory} S ${o.supportedUnit} → ${o.supportedDestination}`;
    case 'CONVOY':       return `${o.unitTerritory} C ${o.supportedUnit} → ${o.targetTerritory}`;
    default:             return JSON.stringify(o);
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setStatus(state: 'connected' | 'disconnected' | 'error', label: string) {
  const el = document.getElementById('conn-status')!;
  el.className = state;
  el.textContent = state === 'connected' ? `● connected` : state === 'error' ? `✕ ${label}` : `○ ${label}`;
}

function showGameSection() {
  document.getElementById('section-lobby')!.style.display = 'none';
  document.getElementById('section-game')!.style.display = 'block';
}

function powerColor(power: Power | string): string {
  const colors: Record<string, string> = {
    AUSTRIA: 'color:#e08080',
    ENGLAND: 'color:#8080e0',
    FRANCE:  'color:#80aee0',
    GERMANY: 'color:#aaaaaa',
    ITALY:   'color:#80c080',
    RUSSIA:  'color:#c0c080',
    TURKEY:  'color:#e0c080',
  };
  return colors[power] ?? 'color:#aaa';
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('btn-create')!.addEventListener('click', () => {
  const name = (document.getElementById('input-name') as HTMLInputElement).value.trim();
  if (!name) return alert('Enter a player name.');
  if (!socket) connect();
  // wait for connect then emit
  const emit = () => {
    socket!.emit('create_game', { playerName: name });
    log('outgoing', 'create_game', { playerName: name });
  };
  socket!.connected ? emit() : socket!.once('connect', emit);
});

document.getElementById('btn-join')!.addEventListener('click', () => {
  const name = (document.getElementById('input-name') as HTMLInputElement).value.trim();
  const gid = (document.getElementById('input-gameid') as HTMLInputElement).value.trim();
  if (!name || !gid) return alert('Enter name and game ID.');
  gameId = gid;
  if (!socket) connect();
  const emit = () => {
    socket!.emit('join_game', { gameId: gid, playerName: name });
    log('outgoing', 'join_game', { gameId: gid, playerName: name });
  };
  socket!.connected ? emit() : socket!.once('connect', emit);
});

document.getElementById('select-order-type')!.addEventListener('change', () => {
  // reset populated flag so dropdowns refresh
  const selTarget = document.getElementById('select-target') as HTMLSelectElement;
  delete selTarget.dataset.populated;
  renderOrderForm();
});

document.getElementById('btn-add-order')!.addEventListener('click', () => {
  if (!selectedUnit || !myPower) return;
  const orderType = (document.getElementById('select-order-type') as HTMLSelectElement).value as OrderType;
  const target    = (document.getElementById('select-target') as HTMLSelectElement).value || null;
  const suppUnit  = (document.getElementById('select-support-unit') as HTMLSelectElement).value || null;
  const suppDest  = (document.getElementById('select-support-dest') as HTMLSelectElement).value || null;

  const order: Order = {
    id: makeOrderId(),
    power: myPower,
    unitTerritory: selectedUnit.territory,
    unitCoast: selectedUnit.coast,
    type: orderType,
    targetTerritory: orderType === 'MOVE' || orderType === 'CONVOY' ? target : null,
    targetCoast: null,
    supportedUnit: (orderType === 'SUPPORT_HOLD' || orderType === 'SUPPORT_MOVE' || orderType === 'CONVOY') ? suppUnit : null,
    supportedDestination: orderType === 'SUPPORT_MOVE' ? suppDest : null,
  };

  // Replace any existing order for this unit
  pendingOrders = pendingOrders.filter(o => o.unitTerritory !== order.unitTerritory);
  pendingOrders.push(order);
  renderPendingOrders();
});

document.getElementById('btn-submit-orders')!.addEventListener('click', () => {
  if (!socket || !gameId || !pendingOrders.length) return;
  socket.emit('submit_orders', { gameId, orders: pendingOrders });
  log('outgoing', 'submit_orders', pendingOrders.map(formatOrder).join(' | '));
});

// ── Boot ──────────────────────────────────────────────────────────────────────

connect();
log('system', 'client ready', 'connecting to localhost:3001…');
