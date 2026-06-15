import assert from 'node:assert/strict';
import test from 'node:test';
import { DiplomacyService } from '../diplomacy/DiplomacyService.js';
import { DiscordLinkService } from '../discord/DiscordLinkService.js';
import { GameManager } from '../GameManager.js';
import { GameRoom } from '../GameRoom.js';
import {
  downsampleDiscordPcm,
  upsampleOpenAiPcm,
} from '../voice/VoiceSessionManager.js';

test('Discord guild and player codes are single-use and resolve a linked seat', () => {
  const manager = new GameManager();
  const room = manager.createGame();
  const joined = room.addPlayer('host-socket', 'Host', 'FRANCE');
  assert.ok(joined);
  const links = new DiscordLinkService(manager, 'guild-one');

  const bind = links.createGuildBindCode(room.gameId, joined.player);
  assert.equal(links.bindGuild(bind.code.toLowerCase(), 'guild-one'), room.gameId);
  assert.throws(() => links.bindGuild(bind.code, 'guild-one'), /invalid or expired/i);

  const playerCode = links.createPlayerLinkCode(room.gameId, joined.player);
  const link = links.linkPlayer(playerCode.code, 'discord-user', 'Discord Player');
  assert.equal(link.playerId, joined.player.id);
  assert.equal(links.resolveDiscordUser('discord-user')?.player.power, 'FRANCE');
  assert.throws(
    () => links.linkPlayer(playerCode.code, 'another-user', 'Another'),
    /invalid or expired/i
  );

  const status = links.getStatus(room.gameId, joined.player.id);
  assert.equal(status.configured, true);
  assert.equal(status.voiceEnabled, false);
  assert.equal(status.guildBound, true);
  assert.equal(status.linked, true);
  assert.equal(status.discordDisplayName, 'Discord Player');
});

test('Discord diplomacy records provenance and deduplicates external messages', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  assert.ok(room.addPlayer('france-socket', 'France', 'FRANCE'));
  assert.ok(room.addLlmPlayer({ power: 'GERMANY' }));
  const diplomacy = new DiplomacyService(manager);

  const first = await diplomacy.send({
    gameId: room.gameId,
    fromPower: 'FRANCE',
    toPower: 'GERMANY',
    body: 'Can we keep Burgundy peaceful?',
    source: 'DISCORD_TEXT',
    externalMessageId: 'discord-message-one',
  });
  const duplicate = await diplomacy.send({
    gameId: room.gameId,
    fromPower: 'FRANCE',
    toPower: 'GERMANY',
    body: 'Can we keep Burgundy peaceful?',
    source: 'DISCORD_TEXT',
    externalMessageId: 'discord-message-one',
  });

  assert.equal(first.length, 2);
  assert.equal(duplicate.length, 0);
  assert.ok(first.every(message => message.source === 'DISCORD_TEXT'));
  assert.equal(first[0].externalMessageId, 'discord-message-one');
  assert.equal(room.getDiplomaticMessages('FRANCE').length, 2);
});

test('messages are stored while an LLM voice lock queues the reply', async () => {
  const manager = new GameManager();
  const room = manager.createGame();
  assert.ok(room.addPlayer('france-socket', 'France', 'FRANCE'));
  assert.ok(room.addLlmPlayer({ power: 'GERMANY' }));
  const diplomacy = new DiplomacyService(manager);
  const releaseVoice = await room.beginVoiceLock('GERMANY', 'FRANCE');
  let completed = false;

  const pending = diplomacy.send({
    gameId: room.gameId,
    fromPower: 'FRANCE',
    toPower: 'GERMANY',
    body: 'Reply after your call.',
    source: 'DISCORD_TEXT',
    externalMessageId: 'queued-message',
  }).then(messages => {
    completed = true;
    return messages;
  });

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(room.getDiplomaticMessages('FRANCE').length, 1);
  assert.equal(room.getDiplomaticMessages('FRANCE')[0].body, 'Reply after your call.');

  releaseVoice();
  const messages = await pending;
  assert.equal(messages.length, 2);
  assert.equal(completed, true);
});

test('voice transcripts reconcile structured LLM memory before the next turn', async () => {
  const room = new GameRoom({
    controllerFactory: ({ power }) => ({
      power,
      async requestDiplomaticInitiative(context) {
        return {
          toPower: null,
          message: '',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async requestDiplomaticReply(context) {
        return {
          reply: 'Acknowledged.',
          strategicSummary: context.memory.strategicSummary,
          agreements: context.memory.agreements,
        };
      },
      async reconcileDiplomaticMemory(context) {
        return {
          strategicSummary: 'France offered to keep Burgundy demilitarized.',
          agreements: [{
            id: 'voice-burgundy',
            parties: ['FRANCE', 'GERMANY'],
            summary: 'Keep Burgundy demilitarized',
            status: 'ACTIVE',
            sourceMessageIds: context.messages.map(message => message.id),
            createdYear: context.state.year,
            createdSeason: context.state.season,
            expiresYear: null,
            expiresSeason: null,
          }],
        };
      },
      async requestOrders() {
        return { actions: [], strategicSummary: '', agreements: [] };
      },
      async requestRetreats() {
        return { actions: {}, strategicSummary: '', agreements: [] };
      },
      async requestBuilds() {
        return {
          actions: { builds: [], disbands: [] },
          strategicSummary: '',
          agreements: [],
        };
      },
    }),
  });
  assert.ok(room.addPlayer('france-socket', 'France', 'FRANCE'));
  assert.ok(room.addLlmPlayer({ power: 'GERMANY', provider: 'OPENAI' }));
  room.recordVoiceTranscript(
    'FRANCE',
    'GERMANY',
    'Let us keep Burgundy demilitarized.',
    false
  );
  room.recordVoiceTranscript(
    'GERMANY',
    'FRANCE',
    'Agreed.',
    true
  );

  await room.reconcileVoiceMemory('GERMANY');

  const memory = room.getLlmDiplomacyMemory('GERMANY');
  assert.match(memory?.strategicSummary ?? '', /Burgundy demilitarized/);
  assert.equal(memory?.agreements[0]?.id, 'voice-burgundy');
  assert.equal(
    room.getLlmRunArtifacts('GERMANY').at(-1)?.structuredDecision &&
      (room.getLlmRunArtifacts('GERMANY').at(-1)?.structuredDecision as { kind: string }).kind,
    'VOICE_MEMORY_RECONCILIATION'
  );
});

test('voice PCM conversion preserves duration and mixes Discord stereo input', () => {
  const discordPcm = Buffer.alloc(16);
  discordPcm.writeInt16LE(1000, 0);
  discordPcm.writeInt16LE(3000, 2);
  discordPcm.writeInt16LE(2000, 4);
  discordPcm.writeInt16LE(4000, 6);
  discordPcm.writeInt16LE(-1000, 8);
  discordPcm.writeInt16LE(-3000, 10);
  discordPcm.writeInt16LE(-2000, 12);
  discordPcm.writeInt16LE(-4000, 14);

  const openAiPcm = downsampleDiscordPcm(discordPcm);
  assert.equal(openAiPcm.length, 4);
  assert.equal(openAiPcm.readInt16LE(0), 2500);
  assert.equal(openAiPcm.readInt16LE(2), -2500);

  const roundTrip = upsampleOpenAiPcm(openAiPcm);
  assert.equal(roundTrip.length, 16);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) => roundTrip.readInt16LE(index * 2)),
    [2500, 2500, 2500, 2500, -2500, -2500, -2500, -2500]
  );
});
