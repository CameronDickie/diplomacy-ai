import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ClientToServerEvents,
  ErrorPayload,
  Order,
  ServerToClientEvents,
} from '@diplomacy/shared';
import type { Server, Socket } from 'socket.io';
import { DiscordLinkService } from '../discord/DiscordLinkService.js';
import { GameManager } from '../GameManager.js';
import { attachDiscordHandlers } from '../handlers/discordHandler.js';
import { attachGameHandlers } from '../handlers/gameHandler.js';
import { attachOrderHandlers } from '../handlers/orderHandler.js';

type ClientEventName = keyof ClientToServerEvents;
type ServerEventName = keyof ServerToClientEvents;
type Handler = (...args: unknown[]) => unknown;

interface EmittedEvent {
  event: ServerEventName | string;
  payload: unknown;
}

class FakeSocket {
  readonly handlers = new Map<string, Handler>();
  readonly emitted: EmittedEvent[] = [];
  readonly data: { authenticated?: boolean } = {};

  constructor(readonly id: string, authenticated = false) {
    this.data.authenticated = authenticated;
  }

  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  join(): void {
    // The handler tests do not need room membership side effects.
  }
}

test('non-host players cannot mutate host-only game setup', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  assert.ok(room.addPlayer('host-socket', 'Host', 'AUSTRIA'));
  assert.ok(room.addPlayer('guest-socket', 'Guest', 'ENGLAND'));

  const guest = socketWithGameHandlers('guest-socket', manager);

  await invoke(guest, 'update_game_settings', {
    gameId: room.gameId,
    llmNegotiationInitiators: 4,
  });
  assertLastError(guest, 'HOST_REQUIRED');
  assert.equal(room.getState().settings.llmNegotiationInitiators, 2);

  await invoke(guest, 'add_llm_player', {
    gameId: room.gameId,
    power: 'FRANCE',
  });
  assertLastError(guest, 'HOST_REQUIRED');
  assert.equal(room.getState().players.some(player => player.power === 'FRANCE'), false);

  await invoke(guest, 'start_game', { gameId: room.gameId });
  assertLastError(guest, 'HOST_REQUIRED');
  assert.equal(room.getState().status, 'LOBBY');
});

test('unauthenticated hosts cannot enable authenticated AI features', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  assert.ok(room.addPlayer('host-socket', 'Host', 'AUSTRIA'));

  const host = socketWithGameHandlers('host-socket', manager);

  await invoke(host, 'add_llm_player', {
    gameId: room.gameId,
    power: 'ENGLAND',
    provider: 'OPENAI',
    model: 'gpt-5.5',
  });
  assertLastError(host, 'AUTH_REQUIRED');
  assert.equal(room.getState().players.some(player => player.power === 'ENGLAND'), false);
  assert.equal(room.getState().accessMode, 'PUBLIC');

  await invoke(host, 'update_game_settings', {
    gameId: room.gameId,
    llmNegotiationPlannerModel: 'gpt-5.4-mini',
  });
  assertLastError(host, 'AUTH_REQUIRED');
  assert.equal(room.getState().settings.llmNegotiationPlannerModel, '');
  assert.equal(room.getState().accessMode, 'PUBLIC');
});

test('authenticated hosts can enable AI and lock the room behind auth', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  assert.ok(room.addPlayer('host-socket', 'Host', 'AUSTRIA'));

  const host = socketWithGameHandlers('host-socket', manager, true);
  await invoke(host, 'add_llm_player', {
    gameId: room.gameId,
    power: 'ENGLAND',
    provider: 'OPENAI',
    model: 'gpt-5.5',
  });

  assert.equal(room.getState().players.some(player => player.power === 'ENGLAND'), true);
  assert.equal(room.getState().accessMode, 'AUTHENTICATED_AI');

  const guest = socketWithGameHandlers('guest-socket', manager);
  await invoke(guest, 'join_game', {
    gameId: room.gameId,
    playerName: 'Guest',
    preferredPower: 'FRANCE',
  });
  assertLastError(guest, 'AUTH_REQUIRED');
  assert.equal(room.getState().players.some(player => player.power === 'FRANCE'), false);
});

test('authenticated AI rooms reject unauthenticated play events', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  room.enableAuthenticatedAiAccess();

  const france = socketWithOrderHandlers('france-socket', manager);
  await invoke(france, 'submit_orders', { gameId: room.gameId, orders: [] });
  assertLastError(france, 'AUTH_REQUIRED');
});

test('order handlers bind submissions to the socket owner power', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  const france = socketWithOrderHandlers('france-socket', manager);

  const austriaOrder: Order = {
    id: 'austria-vie-hold',
    power: 'AUSTRIA',
    unitTerritory: 'VIE',
    unitCoast: null,
    type: 'HOLD',
    targetTerritory: null,
    targetCoast: null,
    supportedUnit: null,
    supportedDestination: null,
  };

  await invoke(france, 'submit_orders', {
    gameId: room.gameId,
    orders: [austriaOrder],
  });
  assertLastError(france, 'INVALID_ORDERS');
  assert.equal(room.getState().submittedPowers.includes('FRANCE'), false);
  assert.equal(room.getState().submittedPowers.includes('AUSTRIA'), false);
});

test('order handlers reject non-participants consistently', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  const attacker = socketWithOrderHandlers('attacker-socket', manager);

  await invoke(attacker, 'submit_orders', { gameId: room.gameId, orders: [] });
  assertLastError(attacker, 'NOT_IN_GAME');

  room.getState().phase = 'RETREATS';
  await invoke(attacker, 'submit_retreats', { gameId: room.gameId, retreats: {} });
  assertLastError(attacker, 'NOT_IN_GAME');

  room.getState().phase = 'BUILDS';
  const builds: [] = [];
  await invoke(attacker, 'submit_builds', { gameId: room.gameId, builds, disbands: [] });
  assertLastError(attacker, 'NOT_IN_GAME');
});

test('Discord browser handlers authorize by the linked socket seat', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  const host = room.addPlayer('host-socket', 'Host', 'FRANCE');
  const guest = room.addPlayer('guest-socket', 'Guest', 'ENGLAND');
  assert.ok(host);
  assert.ok(guest);

  const links = new DiscordLinkService(manager, 'guild-one');
  const guestSocket = socketWithDiscordHandlers('guest-socket', manager, links);
  await invoke(guestSocket, 'create_discord_guild_bind_code', { gameId: room.gameId });
  assertLastError(guestSocket, 'DISCORD_BIND_FAILED');

  const hostSocket = socketWithDiscordHandlers('host-socket', manager, links);
  await invoke(hostSocket, 'create_discord_guild_bind_code', { gameId: room.gameId });
  assert.equal(lastEmitted(hostSocket, 'discord_guild_bind_code_created') !== undefined, true);

  const outsider = socketWithDiscordHandlers('outsider-socket', manager, links);
  await invoke(outsider, 'create_discord_player_link_code', { gameId: room.gameId });
  assertLastError(outsider, 'NOT_IN_GAME');
});

function socketWithGameHandlers(id: string, manager: GameManager, authenticated = false): FakeSocket {
  const socket = new FakeSocket(id, authenticated);
  attachGameHandlers(socket as unknown as Socket<ClientToServerEvents, ServerToClientEvents>, fakeIO(), manager);
  return socket;
}

function socketWithOrderHandlers(id: string, manager: GameManager): FakeSocket {
  const socket = new FakeSocket(id);
  attachOrderHandlers(socket as unknown as Socket<ClientToServerEvents, ServerToClientEvents>, fakeIO(), manager);
  return socket;
}

function socketWithDiscordHandlers(
  id: string,
  manager: GameManager,
  links: DiscordLinkService
): FakeSocket {
  const socket = new FakeSocket(id);
  attachDiscordHandlers(
    socket as unknown as Socket<ClientToServerEvents, ServerToClientEvents>,
    fakeIO(),
    manager,
    links,
    null,
    null
  );
  return socket;
}

function fakeIO(): Server<ClientToServerEvents, ServerToClientEvents> {
  return {
    to() {
      return {
        emit() {
          // Broadcasts are not needed in these authorization tests.
        },
      };
    },
  } as unknown as Server<ClientToServerEvents, ServerToClientEvents>;
}

async function invoke(
  socket: FakeSocket,
  event: ClientEventName,
  payload: unknown
): Promise<void> {
  const handler = socket.handlers.get(event);
  assert.ok(handler, `Missing handler for ${event}`);
  await handler(payload);
}

function assertLastError(socket: FakeSocket, code: ErrorPayload['code']): void {
  const error = lastEmitted(socket, 'error')?.payload as ErrorPayload | undefined;
  assert.equal(error?.code, code);
}

function lastEmitted(socket: FakeSocket, event: string): EmittedEvent | undefined {
  return socket.emitted.filter(emitted => emitted.event === event).at(-1);
}

function GameManagerWithStartedRoom(): GameManager {
  const manager = new GameManager();
  const room = manager.createGame();
  const powers = ['AUSTRIA', 'ENGLAND', 'FRANCE', 'GERMANY', 'ITALY', 'RUSSIA', 'TURKEY'] as const;
  for (const power of powers) {
    assert.ok(room.addPlayer(`${power.toLowerCase()}-socket`, power, power));
  }
  room.getState().status = 'IN_PROGRESS';
  room.getState().phase = 'ORDERS';
  return manager;
}
