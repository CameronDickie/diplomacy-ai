import { createHash, randomUUID } from 'crypto';
import { PassThrough, type Transform } from 'stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import {
  ChannelType,
  PermissionFlagsBits,
  type VoiceChannel,
} from 'discord.js';
import prism from 'prism-media';
import type {
  HumanPlayer,
  Power,
  VoiceSessionState,
  VoiceSessionStatus,
} from '@diplomacy/shared';
import type { GameRoom } from '../GameRoom.js';
import type { GameManager } from '../GameManager.js';
import type { DiscordBotManager } from '../discord/DiscordBotManager.js';
import type { DiscordLinkService } from '../discord/DiscordLinkService.js';
import { OpenAIRealtimeSession } from './OpenAIRealtimeSession.js';

interface ActiveVoiceSession {
  id: string;
  room: GameRoom;
  player: HumanPlayer;
  power: Power;
  discordUserId: string;
  channel: VoiceChannel;
  connection: VoiceConnection;
  audioPlayer: AudioPlayer;
  realtime: OpenAIRealtimeSession;
  releasePowerLock: () => void;
  state: VoiceSessionState;
  inputStream: NodeJS.ReadableStream | null;
  decoder: Transform | null;
  outputStream: PassThrough | null;
  idleTimer: NodeJS.Timeout | null;
  durationTimer: NodeJS.Timeout | null;
  ignoreNextResponseDone: boolean;
  ending: boolean;
}

export class VoiceSessionManager {
  private sessionsByPlayerId = new Map<string, ActiveVoiceSession>();
  private sessionsByPower = new Map<Power, ActiveVoiceSession>();

  constructor(
    private readonly gameManager: GameManager,
    private readonly links: DiscordLinkService,
    private readonly bots: DiscordBotManager,
    readonly enabled: boolean
  ) {}

  getState(playerId: string): VoiceSessionState {
    return this.sessionsByPlayerId.get(playerId)?.state ?? idleVoiceState();
  }

  async start(gameId: string, player: HumanPlayer, power: Power): Promise<void> {
    if (!this.enabled) {
      throw new Error('Discord voice is disabled on this server');
    }
    if (this.sessionsByPlayerId.has(player.id)) {
      throw new Error('You already have an active voice session');
    }
    if (this.sessionsByPower.has(power)) {
      throw new Error(`${power} is already in a voice conversation`);
    }
    const room = this.gameManager.getRoom(gameId);
    const llm = room?.getLlmPlayer(power);
    if (!room || !llm) throw new Error(`${power} is not an active LLM power`);
    if (player.power === power) throw new Error('You cannot call your own power');

    const discordUserId = this.links.getDiscordUserId(player.id);
    if (!discordUserId) throw new Error('Link your Discord account before starting voice');
    const coordinator = this.bots.getCoordinatorClient();
    const powerClient = this.bots.getPowerClient(power);
    if (!coordinator?.user || !powerClient?.user) {
      throw new Error(`${power} voice bot is not connected`);
    }

    const releasePowerLock = await room.beginVoiceLock(power, player.power);
    let provisioningChannel: VoiceChannel | null = null;
    let provisioningConnection: VoiceConnection | null = null;
    let provisioningRealtime: OpenAIRealtimeSession | null = null;
    try {
      this.emitState(room, player, {
        ...idleVoiceState(),
        sessionId: randomUUID(),
        status: 'PROVISIONING',
        power,
        maxTurns: room.getState().settings.voiceMaxTurns,
      });
      const coordinatorGuild = await coordinator.guilds.fetch(this.links.configuredGuildId!);
      const powerGuild = await powerClient.guilds.fetch(this.links.configuredGuildId!);
      const member = await coordinatorGuild.members.fetch(discordUserId);
      const channel = await coordinatorGuild.channels.create({
        name: `diplomacy-${player.power.toLowerCase()}-${power.toLowerCase()}`,
        type: ChannelType.GuildVoice,
        permissionOverwrites: [
          {
            id: coordinatorGuild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          },
          {
            id: discordUserId,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          },
          {
            id: powerClient.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
            ],
          },
          {
            id: coordinator.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
          },
        ],
        reason: `Private Diplomacy voice session for game ${room.gameId}`,
      });
      provisioningChannel = channel;
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: powerGuild.id,
        adapterCreator: powerGuild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      provisioningConnection = connection;
      const audioPlayer = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      });
      connection.subscribe(audioPlayer);

      const sessionId = randomUUID();
      const realtime = new OpenAIRealtimeSession(
        llm.realtimeModel,
        llm.voice,
        room.buildVoiceSessionInstructions(power, player.power),
        hashDiscordUserId(discordUserId),
        {
          onInputTranscript: (transcript, itemId) => {
            const session = this.sessionsByPlayerId.get(player.id);
            if (!session || session.id !== sessionId) return;
            room.recordVoiceTranscript(
              player.power,
              power,
              transcript,
              false,
              itemId
            );
          },
          onAudioDelta: audio => {
            const session = this.sessionsByPlayerId.get(player.id);
            if (!session || session.id !== sessionId) return;
            this.writeOutputAudio(session, audio);
          },
          onOutputTranscript: transcript => {
            const session = this.sessionsByPlayerId.get(player.id);
            if (!session || session.id !== sessionId) return;
            room.recordVoiceTranscript(power, player.power, transcript, true);
          },
          onResponseDone: () => {
            const session = this.sessionsByPlayerId.get(player.id);
            if (!session || session.id !== sessionId) return;
            if (session.ignoreNextResponseDone) {
              session.ignoreNextResponseDone = false;
              return;
            }
            void this.finishResponse(session);
          },
          onError: message => {
            const session = this.sessionsByPlayerId.get(player.id);
            if (!session || session.id !== sessionId || session.ending) return;
            session.state.error = message;
            this.setStatus(session, 'FAILED');
          },
        }
      );
      provisioningRealtime = realtime;
      await realtime.connect();

      const state: VoiceSessionState = {
        sessionId,
        status: 'WAITING_FOR_USER',
        power,
        channelId: channel.id,
        channelUrl: `https://discord.com/channels/${channel.guildId}/${channel.id}`,
        startedAt: new Date().toISOString(),
        turnCount: 0,
        maxTurns: room.getState().settings.voiceMaxTurns,
        error: null,
      };
      const session: ActiveVoiceSession = {
        id: sessionId,
        room,
        player,
        power,
        discordUserId,
        channel,
        connection,
        audioPlayer,
        realtime,
        releasePowerLock,
        state,
        inputStream: null,
        decoder: null,
        outputStream: null,
        idleTimer: null,
        durationTimer: null,
        ignoreNextResponseDone: false,
        ending: false,
      };
      this.sessionsByPlayerId.set(player.id, session);
      this.sessionsByPower.set(power, session);
      session.durationTimer = setTimeout(
        () => void this.end(player.id),
        room.getState().settings.voiceMaxSessionMinutes * 60_000
      );
      this.resetIdleTimer(session);
      this.emit(session);
      if (member.voice.channelId === channel.id) this.setStatus(session, 'READY');
    } catch (error) {
      provisioningRealtime?.close();
      provisioningConnection?.destroy();
      if (provisioningChannel) {
        try {
          await provisioningChannel.delete('Voice session provisioning failed');
        } catch {
          // The channel may already be gone or permissions may have changed.
        }
      }
      releasePowerLock();
      this.emitState(room, player, {
        ...idleVoiceState(),
        status: 'FAILED',
        power,
        error: error instanceof Error ? error.message : 'Voice provisioning failed',
      });
      throw error;
    }
  }

  async beginInput(playerId: string): Promise<void> {
    const session = this.requireSession(playerId);
    if (!['WAITING_FOR_USER', 'READY'].includes(session.state.status)) {
      throw new Error('Voice input cannot start in the current state');
    }
    const powerClient = this.bots.getPowerClient(session.power);
    const guild = await powerClient?.guilds.fetch(session.channel.guildId);
    const member = await guild?.members.fetch(session.discordUserId);
    if (!member || member.voice.channelId !== session.channel.id) {
      throw new Error('Join the temporary Discord voice channel first');
    }

    session.realtime.clearInput();
    const inputStream = session.connection.receiver.subscribe(session.discordUserId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });
    inputStream.pipe(decoder);
    decoder.on('data', chunk => {
      if (session.state.status !== 'LISTENING') return;
      session.realtime.appendAudio(downsampleDiscordPcm(Buffer.from(chunk)));
    });
    decoder.on('error', error => this.fail(session, error.message));
    session.inputStream = inputStream;
    session.decoder = decoder;
    this.setStatus(session, 'LISTENING');
    this.resetIdleTimer(session);
  }

  commitInput(playerId: string): void {
    const session = this.requireSession(playerId);
    if (session.state.status !== 'LISTENING') {
      throw new Error('The voice session is not listening');
    }
    this.stopInput(session);
    session.realtime.commitInput();
    this.setStatus(session, 'PROCESSING');
    this.resetIdleTimer(session);
  }

  interrupt(playerId: string): void {
    const session = this.requireSession(playerId);
    if (!['PROCESSING', 'SPEAKING'].includes(session.state.status)) return;
    session.ignoreNextResponseDone = true;
    session.realtime.interrupt();
    session.audioPlayer.stop(true);
    session.outputStream?.destroy();
    session.outputStream = null;
    this.setStatus(session, 'READY');
    this.resetIdleTimer(session);
  }

  async end(playerId: string): Promise<void> {
    const session = this.sessionsByPlayerId.get(playerId);
    if (!session || session.ending) return;
    session.ending = true;
    this.setStatus(session, 'ENDING');
    this.stopInput(session);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.durationTimer) clearTimeout(session.durationTimer);
    session.realtime.close();
    session.audioPlayer.stop(true);
    session.connection.destroy();
    session.releasePowerLock();
    this.sessionsByPlayerId.delete(playerId);
    this.sessionsByPower.delete(session.power);
    try {
      await session.channel.delete('Diplomacy voice session ended');
    } catch (error) {
      console.warn(`Could not delete voice channel ${session.channel.id}:`, error);
    }
    this.emitState(session.room, session.player, idleVoiceState());
  }

  private writeOutputAudio(session: ActiveVoiceSession, audio: Buffer): void {
    if (!session.outputStream) {
      session.outputStream = new PassThrough();
      session.audioPlayer.play(createAudioResource(session.outputStream, {
        inputType: StreamType.Raw,
      }));
      session.audioPlayer.once(AudioPlayerStatus.Playing, () => {
        if (!session.ending) this.setStatus(session, 'SPEAKING');
      });
    }
    session.outputStream.write(upsampleOpenAiPcm(audio));
  }

  private async finishResponse(session: ActiveVoiceSession): Promise<void> {
    session.outputStream?.end();
    session.outputStream = null;
    session.state.turnCount++;
    this.setStatus(session, 'RECONCILING');
    try {
      await session.room.reconcileVoiceMemory(session.power);
    } catch (error) {
      this.fail(
        session,
        error instanceof Error ? error.message : 'Voice memory reconciliation failed'
      );
      return;
    }
    if (session.ending) return;
    if (session.state.turnCount >= session.state.maxTurns) {
      await this.end(session.player.id);
      return;
    }
    this.setStatus(session, 'READY');
    this.resetIdleTimer(session);
  }

  private stopInput(session: ActiveVoiceSession): void {
    session.inputStream?.unpipe(session.decoder ?? undefined);
    if ('destroy' in (session.inputStream ?? {})) {
      (session.inputStream as NodeJS.ReadableStream & { destroy(): void }).destroy();
    }
    session.decoder?.destroy();
    session.inputStream = null;
    session.decoder = null;
  }

  private setStatus(session: ActiveVoiceSession, status: VoiceSessionStatus): void {
    session.state = { ...session.state, status };
    this.emit(session);
  }

  private fail(session: ActiveVoiceSession, message: string): void {
    session.state = { ...session.state, error: message };
    this.setStatus(session, 'FAILED');
  }

  private resetIdleTimer(session: ActiveVoiceSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => void this.end(session.player.id),
      session.room.getState().settings.voiceIdleTimeoutSeconds * 1000
    );
  }

  private emit(session: ActiveVoiceSession): void {
    this.emitState(session.room, session.player, session.state);
  }

  private emitState(
    room: GameRoom,
    player: HumanPlayer,
    state: VoiceSessionState
  ): void {
    room.emitToPlayer(player.id, 'voice_session_state', {
      state: structuredClone(state),
    });
  }

  private requireSession(playerId: string): ActiveVoiceSession {
    const session = this.sessionsByPlayerId.get(playerId);
    if (!session) throw new Error('No active voice session');
    return session;
  }
}

function idleVoiceState(): VoiceSessionState {
  return {
    sessionId: null,
    status: 'IDLE',
    power: null,
    channelId: null,
    channelUrl: null,
    startedAt: null,
    turnCount: 0,
    maxTurns: 0,
    error: null,
  };
}

export function downsampleDiscordPcm(input: Buffer): Buffer {
  const frameCount = Math.floor(input.length / 4);
  const output = Buffer.allocUnsafe(Math.floor(frameCount / 2) * 2);
  let outputOffset = 0;
  for (let frame = 0; frame + 1 < frameCount; frame += 2) {
    const firstOffset = frame * 4;
    const secondOffset = (frame + 1) * 4;
    const sample = Math.round((
      input.readInt16LE(firstOffset) +
      input.readInt16LE(firstOffset + 2) +
      input.readInt16LE(secondOffset) +
      input.readInt16LE(secondOffset + 2)
    ) / 4);
    output.writeInt16LE(sample, outputOffset);
    outputOffset += 2;
  }
  return output;
}

export function upsampleOpenAiPcm(input: Buffer): Buffer {
  const samples = Math.floor(input.length / 2);
  const output = Buffer.allocUnsafe(samples * 8);
  let outputOffset = 0;
  for (let index = 0; index < samples; index++) {
    const sample = input.readInt16LE(index * 2);
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      output.writeInt16LE(sample, outputOffset);
      output.writeInt16LE(sample, outputOffset + 2);
      outputOffset += 4;
    }
  }
  return output;
}

function hashDiscordUserId(discordUserId: string): string {
  return createHash('sha256').update(discordUserId).digest('hex');
}
