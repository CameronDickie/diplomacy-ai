import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntegrations } from '../integrations.js';
import { readRuntimeConfig } from '../../../config/runtime.cjs';
import { GameManager } from '../GameManager.js';
import { DiplomacyService } from '../diplomacy/DiplomacyService.js';
import { attachHandlers } from '../handlers/connectionHandler.js';
import { bindSocketPolicy } from '../auth/socketPolicy.js';
import { DiscordLinkService } from '../discord/DiscordLinkService.js';
import { attachDiscordHandlers } from '../handlers/discordHandler.js';

const events = ['create_discord_guild_bind_code', 'create_discord_player_link_code', 'request_discord_link_status',
  'start_voice_session', 'begin_voice_input', 'commit_voice_input', 'interrupt_voice_response', 'end_voice_session'];
function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const emitted: Array<{ event: string; value: unknown }> = [];
  return { id: 'seat', connected: true, handlers, emitted,
    on(event: string, handler: (payload: unknown) => Promise<void>) { handlers.set(event, handler); },
    emit(event: string, value: unknown) { emitted.push({ event, value }); },
  };
}

test('showcase and disabled integrations never invoke factories or attach integration handlers', async () => {
  for (const profile of ['showcase', 'local', 'private']) {
    const config = readRuntimeConfig({ DIPLOMACY_PROFILE: profile });
    if (profile === 'showcase') config.discord.enabled = true; // Independent defense even with a forged internal config.
    const manager = new GameManager(), diplomacy = new DiplomacyService(manager);
    let calls = 0;
    const integrations = await createIntegrations(config, manager, diplomacy, async () => { calls++; throw new Error('Must not initialize'); });
    assert.equal(integrations, null); assert.equal(calls, 0);
    const socket = fakeSocket();
    bindSocketPolicy(socket, { profile: 'local', resolve: async () => null });
    attachHandlers(socket as never, {} as never, manager, { diplomacy, integrations });
    for (const event of events) assert.equal(socket.handlers.has(event), false, event);
    assert.equal(manager.getRooms().length, 0);
  }
});

test('explicit private enablement invokes the integration factory once', async () => {
  const config = readRuntimeConfig({ DIPLOMACY_PROFILE: 'private', DISCORD_ENABLED: 'true', DISCORD_GUILD_ID: 'synthetic', DISCORD_COORDINATOR_TOKEN: 'synthetic' });
  const manager = new GameManager(); let calls = 0;
  const result = await createIntegrations(config, manager, new DiplomacyService(manager), async () => {
    calls++; return { links: new DiscordLinkService(manager, 'synthetic'), bots: {} as never, voice: null };
  });
  assert.equal(calls, 1); assert.ok(result);
  const socket = fakeSocket();
  attachHandlers(socket as never, {} as never, manager, { diplomacy: new DiplomacyService(manager), integrations: result });
  for (const event of events.slice(0, 3)) assert.equal(socket.handlers.has(event), true);
  for (const event of events.slice(3)) assert.equal(socket.handlers.has(event), false, 'disabled voice has no handlers');
});

test('enabled integration hooks reject guest and non-operator room hosts before mutating links or voice', async () => {
  const manager = new GameManager(), room = manager.createGame();
  room.addPlayer('seat', 'Room host', 'FRANCE');
  for (const principal of [null, {
    player: { id: 'ordinary', provider: 'google' as const, subject: '123', displayName: 'Room host', bannedAt: null },
    operator: false, expiresAt: Date.now() + 60000,
  }]) {
    const socket = fakeSocket();
    bindSocketPolicy(socket, { profile: 'local', resolve: async () => principal });
    let calls = 0;
    const links = new Proxy({}, { get() { calls++; throw new Error('Must not touch integration state'); } });
    const voice = new Proxy({}, { get() { calls++; throw new Error('Must not start voice'); } });
    attachDiscordHandlers(socket as never, {} as never, manager, links as never, {} as never, voice as never);
    for (const event of events) await socket.handlers.get(event)!({ gameId: room.gameId, ...(event === 'start_voice_session' ? { toPower: 'ENGLAND' } : {}) });
    assert.equal(calls, 0);
    assert.equal(socket.emitted.length, events.length);
    for (const { value } of socket.emitted) assert.equal((value as { code: string }).code, 'OPERATOR_REQUIRED');
  }
});
