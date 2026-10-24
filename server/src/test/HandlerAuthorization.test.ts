import assert from 'node:assert/strict';
import test from 'node:test';
import { gamePhaseId } from '@diplomacy/shared';
import type {
  ClientToServerEvents,
  ErrorPayload,
  Order,
  ServerToClientEvents,
} from '@diplomacy/shared';
import type { Server, Socket } from 'socket.io';
import { DiscordLinkService } from '../discord/DiscordLinkService.js';
import { GameManager } from '../GameManager.js';
import { buildLlmRuntimePolicy } from '../llm/policy.js';
import { attachDiscordHandlers } from '../handlers/discordHandler.js';
import { attachGameHandlers } from '../handlers/gameHandler.js';
import { attachOrderHandlers } from '../handlers/orderHandler.js';
import { attachHandlers } from '../handlers/connectionHandler.js';
import { bindSocketPolicy } from '../auth/socketPolicy.js';
import { onClientEvent } from '../handlers/clientEvent.js';
import { DiplomacyService } from '../diplomacy/DiplomacyService.js';
import type { Principal } from '../auth.js';
import { RateLimiter, RATE_POLICY } from '../limits/RateLimiter.js';
import { isOfflineSeatModel } from '../llm/PracticeBotController.js';
import { modelRequiresAuthenticatedAi } from '../handlers/authz.js';

type ClientEventName = keyof ClientToServerEvents;
type ServerEventName = keyof ServerToClientEvents;
type Handler = (...args: unknown[]) => unknown;

interface EmittedEvent {
  event: ServerEventName | string;
  payload: unknown;
}

class FakeSocket {
  connected = true;
  readonly handlers = new Map<string, Handler>();
  readonly emitted: EmittedEvent[] = [];
  readonly data: { authenticated?: boolean } = {};

  constructor(readonly id: string, authenticated = false) {
    this.data.authenticated = authenticated;
    // Synthetic server-side resolver. Socket data alone is never production authority.
    bindSocketPolicy(this, { profile: 'local', resolve: async () => this.data.authenticated ? {
      player: { id, provider: 'github', subject: '123', displayName: 'Test operator', bannedAt: null },
      operator: true, expiresAt: Date.now() + 60000,
    } : null });
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

for (const event of ['create_game', 'join_game', 'resume_game'] as const) {
  test(`${event} cannot attach a seat after disconnecting during authentication`, async t => {
    const manager = new GameManager({}, { maxRooms: 2, maxRoomsPerAccount: 1 });
    t.after(() => manager.dispose());
    const socket = new FakeSocket('disconnected-socket');
    const principal: Principal = {
      player: { id: 'alice', provider: 'github', subject: '123', displayName: 'Alice', bannedAt: null },
      operator: false, expiresAt: Date.now() + 60000,
    };
    let release!: (principal: Principal) => void;
    bindSocketPolicy(socket, {
      profile: 'showcase', games: true,
      resolve: () => new Promise<Principal>(resolve => { release = resolve; }),
    });
    attachHandlers(socket as never, fakeIO(), manager, {
      diplomacy: new DiplomacyService(manager), integrations: null,
    });
    let payload: unknown = { playerName: 'Alice' };
    if (event !== 'create_game') {
      const room = manager.createGame();
      const joined = room.addPlayer('old-socket', 'Alice')!;
      room.markDisconnected('old-socket');
      payload = event === 'join_game'
        ? { gameId: room.gameId, playerName: 'Alice' }
        : { gameId: room.gameId, sessionToken: joined.sessionToken };
    }
    const before = structuredClone(manager.getRooms().map(room => room.getState()));
    const pending = invoke(socket, event, payload);
    socket.connected = false;
    await socket.handlers.get('disconnect')!();
    release(principal);
    await pending;
    assert.deepEqual(manager.getRooms().map(room => room.getState()), before);
    assert.equal(manager.getRoomBySocket(socket.id), undefined);
    assert.equal(manager.refusal('alice', true), null);
    assert.deepEqual(socket.emitted, []);
  });
}

for (const event of ['create_game', 'join_game', 'resume_game'] as const) {
  test(`${event} malformed floods consume address permits before validation or authentication`, async () => {
    let now = 0;
    const limiter = new RateLimiter('none', () => now);
    let resolved = 0;
    let handled = 0;
    const makeSocket = (id: string) => {
      const socket = new FakeSocket(id);
      bindSocketPolicy(socket, {
        profile: 'local', limits: { limiter, address: '192.0.2.1' },
        resolve: async () => { resolved++; return null; },
      });
      onClientEvent(socket as never, event, () => { handled++; });
      return socket;
    };
    const socket = makeSocket('flood');
    for (let index = 0; index < 1000; index++) await invoke(socket, event, { playerName: 123 });
    const errorEvent = event === 'create_game' ? 'error' : event === 'join_game' ? 'join_error' : 'resume_error';
    const errors = socket.emitted.map(reply => {
      assert.equal(reply.event, errorEvent);
      return (reply.payload as ErrorPayload).code;
    });
    assert.equal(errors.filter(code => code === 'INVALID_PAYLOAD').length, RATE_POLICY.room.address.limit);
    assert.equal(errors.filter(code => code === 'RATE_LIMITED').length, 1000 - RATE_POLICY.room.address.limit);
    assert.equal(resolved, 0);
    assert.equal(handled, 0);
    const reconnected = makeSocket('reconnected');
    const valid = event === 'create_game' ? { playerName: 'Alice' }
      : event === 'join_game' ? { gameId: 'ROOM', playerName: 'Alice' }
        : { gameId: 'ROOM', sessionToken: 'token' };
    await invoke(reconnected, event, valid);
    assert.equal((reconnected.emitted.at(-1)!.payload as ErrorPayload).code, 'RATE_LIMITED');
    now += 60000;
    for (let index = 0; index < RATE_POLICY.room.address.limit; index++) await invoke(reconnected, event, valid);
    assert.equal(handled, RATE_POLICY.room.address.limit);
    assert.equal(resolved, handled);
    await invoke(reconnected, event, valid);
    assert.equal(handled, RATE_POLICY.room.address.limit);
    assert.equal((reconnected.emitted.at(-1)!.payload as ErrorPayload).code, 'RATE_LIMITED');
  });
}

test('blank planner defaults keep a local room accessible to anonymous guests', async t => {
  const manager = new GameManager();
  t.after(() => manager.dispose());
  const room = manager.createGame();
  room.addPlayer('host', 'Host', 'FRANCE');
  const host = socketWithGameHandlers('host', manager, true);
  for (const model of [undefined, '', ' \t\n ', ' IDLE ', ' AUTO-HOLD-V0 ', ' PRACTICE-BOT-V1 ']) {
    assert.equal(isOfflineSeatModel(model), true);
    assert.equal(modelRequiresAuthenticatedAi(model), false);
  }
  for (const model of ['', ' \t\n ']) {
    await invoke(host, 'update_game_settings', { gameId: room.gameId, llmNegotiationPlannerModel: model });
    assert.equal(room.getState().settings.llmNegotiationPlannerModel, '');
    assert.equal(room.requiresAuthenticatedAccess(), false);
    const guest = socketWithGameHandlers(`guest-${model}`, manager);
    await invoke(guest, 'join_game', { gameId: room.gameId, playerName: 'Guest' });
    assert.ok(lastEmitted(guest, 'game_joined'));
  }
  assert.equal(lastEmitted(host, 'error'), undefined);
  assert.equal(modelRequiresAuthenticatedAi('gpt-6-luna'), true);
});

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
    model: 'gpt-5.4-mini',
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

test('authenticated hosts can enable AI and lock the room behind auth when paid policy is explicit', async () => {
  const manager = paidSetupManager();
  const room = manager.createGame();
  assert.ok(room.addPlayer('host-socket', 'Host', 'AUSTRIA'));

  const host = socketWithGameHandlers('host-socket', manager, true);
  await invoke(host, 'add_llm_player', {
    gameId: room.gameId,
    power: 'ENGLAND',
    provider: 'OPENAI',
    model: 'gpt-5.4-mini',
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

test('authenticated hosts cannot select disallowed paid models', async () => {
  const manager = paidSetupManager();
  const room = manager.createGame();
  assert.ok(room.addPlayer('host-socket', 'Host', 'AUSTRIA'));

  const host = socketWithGameHandlers('host-socket', manager, true);
  await invoke(host, 'add_llm_player', {
    gameId: room.gameId,
    power: 'ENGLAND',
    provider: 'OPENAI',
    model: 'gpt-5.5',
  });

  assertLastError(host, 'INVALID_LLM_MODEL');
  assert.equal(room.getState().players.some(player => player.power === 'ENGLAND'), false);
});

test('authenticated AI rooms reject unauthenticated play events', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  room.enableAuthenticatedAiAccess();

  const france = socketWithOrderHandlers('france-socket', manager);
  await invoke(france, 'submit_orders', { gameId: room.gameId, phaseId: gamePhaseId(room.getState()), orders: [] });
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
    phaseId: gamePhaseId(room.getState()),
  });
  assertLastError(france, 'INVALID_ORDERS');
  assert.equal(room.getState().submittedPowers.includes('FRANCE'), false);
  assert.equal(room.getState().submittedPowers.includes('AUSTRIA'), false);
});

test('order handlers reject non-participants consistently', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  const attacker = socketWithOrderHandlers('attacker-socket', manager);

  await invoke(attacker, 'submit_orders', { gameId: room.gameId, phaseId: gamePhaseId(room.getState()), orders: [] });
  assertLastError(attacker, 'NOT_IN_GAME');

  room.getState().phase = 'RETREATS';
  await invoke(attacker, 'submit_retreats', { gameId: room.gameId, phaseId: gamePhaseId(room.getState()), retreats: {} });
  assertLastError(attacker, 'NOT_IN_GAME');

  room.getState().phase = 'BUILDS';
  const builds: [] = [];
  await invoke(attacker, 'submit_builds', { gameId: room.gameId, phaseId: gamePhaseId(room.getState()), builds, disbands: [] });
  assertLastError(attacker, 'NOT_IN_GAME');
});

test('a seated player is sent their own legal orders for the phase, and an outsider is refused', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  const france = socketWithOrderHandlers('france-socket', manager);
  await invoke(france, 'request_legal_orders', { gameId: room.gameId });
  const sent = lastEmitted(france, 'legal_orders')?.payload as { phaseId: string; power: string; options: Array<{ id: string; unitTerritory: string; order: Order }> };
  assert.equal(sent.power, 'FRANCE');
  assert.equal(sent.phaseId, gamePhaseId(room.getState()));
  assert.deepEqual([...new Set(sent.options.map(option => option.unitTerritory))].sort(), ['BRE', 'MAR', 'PAR']);
  assert.ok(sent.options.every(option => option.order.power === 'FRANCE'));
  assert.ok(sent.options.some(option => option.id === 'PAR|MOVE|BUR'));
  const outsider = socketWithOrderHandlers('outsider-socket', manager);
  await invoke(outsider, 'request_legal_orders', { gameId: room.gameId });
  assertLastError(outsider, 'NOT_IN_GAME');
  assert.equal(lastEmitted(outsider, 'legal_orders'), undefined);
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
  const socket = new FakeSocket(id, true);
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
    in() {
      return { socketsLeave() {} };
    },
    to() {
      return {
        emit() {
          // Broadcasts are not needed in these authorization tests.
        },
      };
    },
  } as unknown as Server<ClientToServerEvents, ServerToClientEvents>;
}

test('every transport handler rejects malformed input without throwing or creating rooms', async () => {
  const manager = new GameManager();
  const socket = new FakeSocket('malformed-socket');
  attachHandlers(socket as unknown as Socket<ClientToServerEvents, ServerToClientEvents>, fakeIO(), manager, {
    diplomacy: new DiplomacyService(manager),
    integrations: null,
  });
  for (const [event, handler] of socket.handlers) {
    if (event === 'disconnect') continue;
    for (const value of [null, [], 42, 'wrong', { gameId: 42 }, ...(event === 'request_state' ? [] : [undefined])]) {
      const previousCount = socket.emitted.length;
      await handler(value);
      assert.equal(socket.emitted.length, previousCount + 1, event);
      assert.equal((socket.emitted.at(-1)?.payload as ErrorPayload).code, 'INVALID_PAYLOAD', event);
    }
  }
  await invoke(socket, 'create_game', { playerName: 42 });
  assertLastError(socket, 'INVALID_PAYLOAD');
  assert.equal(manager.getRooms().length, 0);
});

test('nested malformed orders, builds and settings leave a room unchanged', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  const socket = socketWithOrderHandlers('france-socket', manager);
  attachGameHandlers(socket as unknown as Socket<ClientToServerEvents, ServerToClientEvents>, fakeIO(), manager);
  const before = structuredClone(room.getState());
  const base = { gameId: room.gameId, phaseId: gamePhaseId(room.getState()) };
  for (const orders of [null, [null], Array(35).fill({}), [{ type: 'TELEPORT' }]]) {
    await invoke(socket, 'submit_orders', { ...base, orders });
    assertLastError(socket, 'INVALID_PAYLOAD');
  }
  await invoke(socket, 'submit_builds', {
    ...base, builds: [{ type: 'SUBMARINE', territory: 'BRE', coast: null }], disbands: [],
  });
  assertLastError(socket, 'INVALID_PAYLOAD');
  await invoke(socket, 'update_game_settings', { gameId: room.gameId, llmNegotiationPlannerModel: null });
  assertLastError(socket, 'INVALID_PAYLOAD');
  await invoke(socket, 'update_game_settings', { gameId: room.gameId, unknownSetting: true });
  assertLastError(socket, 'INVALID_PAYLOAD');
  assert.deepEqual(room.getState(), before);
});

test('the event boundary catches both thrown exceptions and rejected promises', async () => {
  const socket = new FakeSocket('exception-socket');
  for (const handler of [
    () => { throw new Error('private error details'); },
    async () => { throw new Error('private error details'); },
  ]) {
    onClientEvent(socket as unknown as Socket<ClientToServerEvents, ServerToClientEvents>, 'request_state', handler);
    await invoke(socket, 'request_state', undefined);
    assertLastError(socket, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(socket.emitted).includes('private error details'), false);
  }
});

test('joining twice or joining another room cannot change the socket seat', async () => {
  const manager = new GameManager();
  const first = manager.createGame();
  first.addPlayer('joined-socket', 'England', 'ENGLAND');
  const other = manager.createGame();
  const socket = socketWithGameHandlers('joined-socket', manager);
  for (const room of [first, other]) {
    await invoke(socket, 'join_game', { gameId: room.gameId, playerName: 'France', preferredPower: 'FRANCE' });
    assert.equal((lastEmitted(socket, 'join_error')?.payload as ErrorPayload).code, 'ALREADY_IN_GAME');
  }
  assert.equal(first.getState().players.length, 1);
  assert.equal(other.getState().players.length, 0);
  assert.equal(first.getPlayerBySocket(socket.id)?.power, 'ENGLAND');
});

test('resume cannot attach an occupied socket to another room', async () => {
  const manager = new GameManager();
  const first = manager.createGame();
  first.addPlayer('joined-socket', 'England', 'ENGLAND');
  const other = manager.createGame();
  const target = other.addPlayer('other-socket', 'France', 'FRANCE')!;
  const socket = socketWithGameHandlers('joined-socket', manager);
  await invoke(socket, 'resume_game', { gameId: other.gameId, sessionToken: target.sessionToken });
  assert.equal((lastEmitted(socket, 'resume_error')?.payload as ErrorPayload).code, 'ALREADY_IN_GAME');
  assert.equal(other.hasSocket(socket.id), false);
  assert.equal(other.hasSocket('other-socket'), true);
});

test('orders, retreats and builds reject stale phase IDs and synchronize the board', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  const socket = socketWithOrderHandlers('france-socket', manager);
  const commands = [
    ['ORDERS', 'submit_orders', { orders: [] }],
    ['RETREATS', 'submit_retreats', { retreats: {} }],
    ['BUILDS', 'submit_builds', { builds: [], disbands: [] }],
  ] as const;
  for (const [phase, event, actions] of commands) {
    room.getState().phase = phase;
    const before = structuredClone(room.getState());
    const phaseId = gamePhaseId({ ...before, year: before.year - 1 });
    await invoke(socket, event, { gameId: room.gameId, phaseId, ...actions });
    assertLastError(socket, 'STALE_PHASE');
    assert.ok(lastEmitted(socket, 'game_state_sync'));
    assert.deepEqual(room.getState(), before);
  }
});

test('replaying the last human orders cannot resolve the next season', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  room.addPlayer('human-socket', 'England', 'ENGLAND');
  for (let i = 0; i < 6; i++) room.addLlmPlayer();
  await room.startGame();
  const socket = socketWithOrderHandlers('human-socket', manager);
  socket.data.authenticated = true;
  const command = { gameId: room.gameId, phaseId: gamePhaseId(room.getState()), orders: [] };
  await invoke(socket, 'submit_orders', command);
  assert.equal(room.getState().season, 'FALL');
  const after = structuredClone(room.getState());
  await invoke(socket, 'submit_orders', command);
  assert.equal(lastEmitted(socket, 'error'), undefined);
  await invoke(socket, 'submit_orders', { ...command, requestId: 'new-stale-request' });
  assertLastError(socket, 'STALE_PHASE');
  assert.deepEqual(room.getState(), after);
});

test('clients without a phase ID cannot submit orders', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  const socket = socketWithOrderHandlers('france-socket', manager);
  await invoke(socket, 'submit_orders', { gameId: room.gameId, orders: [] });
  assertLastError(socket, 'INVALID_PAYLOAD');
  assert.deepEqual(room.getState().submittedPowers, []);
});

test('resuming a seat delivers its accepted submission state', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  const joined = room.addPlayer('old-socket', 'France', 'FRANCE')!;
  room.getState().status = 'IN_PROGRESS';
  const command = {
    phase: 'ORDERS' as const, phaseId: gamePhaseId(room.getState()), requestId: 'resume-receipt', orders: [],
  };
  // Keep resolution pending on another human so this phase remains open.
  room.getState().status = 'LOBBY';
  room.addPlayer('other-socket', 'England', 'ENGLAND');
  room.getState().status = 'IN_PROGRESS';
  const accepted = await room.submitCommand('FRANCE', command);
  assert.equal(accepted.status, 'ACCEPTED');
  room.markDisconnected('old-socket');
  const socket = socketWithGameHandlers('new-socket', manager);
  await invoke(socket, 'resume_game', { gameId: room.gameId, sessionToken: joined.sessionToken });
  assert.deepEqual(lastEmitted(socket, 'submission_state')?.payload, accepted);
});

test('commands without request IDs are rejected at the transport boundary', async () => {
  const manager = GameManagerWithStartedRoom();
  const room = manager.getRooms()[0];
  const socket = socketWithOrderHandlers('france-socket', manager);
  await socket.handlers.get('submit_orders')!({ gameId: room.gameId, phaseId: gamePhaseId(room.getState()), orders: [] });
  assertLastError(socket, 'INVALID_PAYLOAD');
});

async function invoke(
  socket: FakeSocket,
  event: ClientEventName,
  payload: unknown
): Promise<void> {
  const handler = socket.handlers.get(event);
  assert.ok(handler, `Missing handler for ${event}`);
  if (event.startsWith('submit_') && payload && typeof payload === 'object') {
    payload = { requestId: 'test-request', ...payload };
  }
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

function paidSetupManager(): GameManager {
  // These tests only configure seats; no game or provider call is started.
  return new GameManager({ llmPolicy: buildLlmRuntimePolicy({
    DIPLOMACY_PAID_AI_ENABLED: 'true', LLM_TOTAL_BUDGET_USD: '5',
  }) });
}


test('local anonymous practice can add offline bots without gaining operator capabilities', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  room.addPlayer('local-socket', 'France', 'FRANCE');
  const socket = socketWithGameHandlers('local-socket', manager);
  await invoke(socket, 'add_llm_player', { gameId: room.gameId, provider: 'STUB', model: 'auto-hold-v0' });
  assert.equal(room.getState().players.length, 2);
  assert.equal(room.requiresAuthenticatedAccess(), false);
  await invoke(socket, 'add_llm_player', { gameId: room.gameId, provider: 'OPENAI', model: 'gpt-6-luna' });
  assertLastError(socket, 'AUTH_REQUIRED');
  assert.equal(room.getState().players.length, 2);
});

test('signed-in room hosts cannot configure providers without a server-owned operator role', async () => {
  const manager = paidSetupManager();
  const room = manager.createGame();
  room.addPlayer('ordinary-host', 'France', 'FRANCE');
  const socket = socketWithGameHandlers('ordinary-host', manager, true);
  bindSocketPolicy(socket, { profile: 'private', resolve: async () => ({
    player: { id: 'player', provider: 'google', subject: '123', displayName: 'Owner', bannedAt: null },
    operator: false, expiresAt: Date.now() + 60000,
  }) });
  await invoke(socket, 'add_llm_player', { gameId: room.gameId, provider: 'OPENAI', model: 'gpt-6-luna' });
  assertLastError(socket, 'OPERATOR_REQUIRED');
  await invoke(socket, 'update_game_settings', { gameId: room.gameId, llmNegotiationPlannerModel: 'gpt-6-luna' });
  assertLastError(socket, 'OPERATOR_REQUIRED');
  assert.equal(room.getState().players.length, 1);
});
