import { createHash, randomUUID } from 'crypto';
import { PassThrough, type Transform } from 'stream';
import type { Readable } from 'stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import {
  ChannelType,
  PermissionFlagsBits,
  Routes,
  type GuildMember,
  type VoiceChannel,
} from 'discord.js';
import prism from 'prism-media';
import type {
  HumanPlayer,
  Power,
  VoiceSessionState,
  VoiceSessionStatus,
} from '@diplomacy/shared';
import { ALL_POWERS } from '@diplomacy/shared';
import type { GameRoom } from '../GameRoom.js';
import type { GameManager } from '../GameManager.js';
import type { DiscordBotManager } from '../discord/DiscordBotManager.js';
import type { DiscordLinkService } from '../discord/DiscordLinkService.js';
import { OpenAIRealtimeSession } from './OpenAIRealtimeSession.js';

interface ActiveVoiceSession {
  id: string;
  room: GameRoom;
  player: HumanPlayer;
  targetPlayer: HumanPlayer | null;
  power: Power;
  discordUserId: string;
  targetDiscordUserId: string | null;
  channel: VoiceChannel;
  kind: 'LLM' | 'HUMAN';
  connection: VoiceConnection | null;
  audioPlayer: AudioPlayer | null;
  realtime: OpenAIRealtimeSession | null;
  releasePowerLock: (() => void) | null;
  state: VoiceSessionState;
  inputStream: NodeJS.ReadableStream | null;
  decoder: Transform | null;
  outputStream: PassThrough | null;
  inputAudioMs: number;
  receivePackets: number;
  outputAudioMs: number;
  startedSpeaking: boolean;
  userJoinedChannel: boolean;
  presenceTimer: NodeJS.Timeout | null;
  autoCommitTimer: NodeJS.Timeout | null;
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
    readonly enabled: boolean,
    private readonly debugEnabled = false,
    private readonly autoListenEnabled = true
  ) {
    if (enabled) {
      const cleanupTimer = setInterval(
        () => void this.cleanupEmptyTemporaryChannels(),
        60_000
      );
      cleanupTimer.unref?.();
    }
  }

  getState(playerId: string): VoiceSessionState {
    const session = this.sessionsByPlayerId.get(playerId);
    if (!session) return idleVoiceState();
    const player = this.sessionPlayers(session).find(candidate => candidate.id === playerId);
    return player ? this.stateForPlayer(session, player) : session.state;
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
    if (!room) throw new Error('Game not found');
    if (player.power === power) throw new Error('You cannot call your own power');

    const llm = room.getLlmPlayer(power);
    if (!llm) {
      await this.startHumanSession(room, player, power);
      return;
    }

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
      const powerGuild = powerClient.guilds.cache.get(this.links.configuredGuildId!) ??
        await powerClient.guilds.fetch(this.links.configuredGuildId!);
      const member = await coordinatorGuild.members.fetch(discordUserId);
      const powerMember = await coordinatorGuild.members.fetch(powerClient.user.id);
      const coordinatorMember = await coordinatorGuild.members.fetch(coordinator.user.id);
      const channel = await coordinatorGuild.channels.create({
        name: `diplomacy-${player.power.toLowerCase()}-${power.toLowerCase()}`,
        type: ChannelType.GuildVoice,
        userLimit: 2,
        permissionOverwrites: [
          {
            id: coordinatorGuild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          },
          {
            id: discordUserId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.UseVAD,
            ],
          },
          {
            id: powerMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.UseVAD,
              PermissionFlagsBits.ManageChannels,
            ],
          },
          {
            id: coordinatorMember.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
          },
        ],
        reason: `Private Diplomacy voice session for game ${room.gameId}`,
      });
      provisioningChannel = channel;
      await this.tryMoveMemberToChannel(member, channel);
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: powerGuild.id,
        adapterCreator: powerGuild.voiceAdapterCreator,
        daveEncryption: true,
        decryptionFailureTolerance: 100,
        debug: this.debugEnabled,
        selfDeaf: false,
        selfMute: false,
      });
      connection.on('stateChange', (oldState, newState) => {
        if (this.debugEnabled) {
          console.log(
            `[voice ${power} provisioning] voice connection ${oldState.status} -> ${newState.status}`
          );
        }
        const networking = Reflect.get(newState, 'networking') as { once?: (event: 'close', listener: (code: number) => void) => void } | undefined;
        networking?.once?.('close', code => {
          if (this.debugEnabled) {
            console.log(`[voice ${power} provisioning] networking closed with code ${code}`);
          }
        });
      });
      connection.on('debug', message => {
        if (this.debugEnabled) console.log(`[voice ${power} provisioning] ${message}`);
      });
      connection.on('error', error => {
        console.warn(`[voice ${power} provisioning] ${error.message}`);
      });
      provisioningConnection = connection;
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
      } catch {
        throw new Error(
          `${power} voice bot could not finish joining the Discord voice channel. ` +
          `The connection stayed ${connection.state.status}; verify that the ${power} bot is installed in the guild, has Connect/View Channel on the temporary voice channel, and that the bot process is receiving GuildVoiceStates events.`
        );
      }
      const sessionId = randomUUID();
      const audioPlayer = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play },
      });
      audioPlayer.on('error', error => {
        const session = this.sessionsByPlayerId.get(player.id);
        if (!session || session.id !== sessionId || session.ending) return;
        this.fail(session, `Discord audio playback failed: ${error.message}`);
      });
      connection.subscribe(audioPlayer);

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
          onClose: (code, reason) => {
            const session = this.sessionsByPlayerId.get(player.id);
            if (!session || session.id !== sessionId || session.ending) return;
            const ageSeconds = session.state.startedAt
              ? Math.round((Date.now() - Date.parse(session.state.startedAt)) / 1000)
              : 0;
            const detail =
              `OpenAI realtime socket closed: code=${code}; reason=${reason || 'none'}; ` +
              `age=${ageSeconds}s; model=${llm.realtimeModel}; voice=${llm.voice}; ` +
              `in=${session.state.inputAudioMs}ms/${session.state.receivePackets}pkts; ` +
              `out=${session.state.outputAudioMs}ms`;
            this.recordVoiceDebug(session, detail);
            if (code !== 1000) this.fail(session, detail);
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
        inputAudioMs: 0,
        receivePackets: 0,
        outputAudioMs: 0,
        debug: [],
        error: null,
      };
      const session: ActiveVoiceSession = {
        id: sessionId,
        room,
        player,
        targetPlayer: null,
        power,
        discordUserId,
        targetDiscordUserId: null,
        channel,
        kind: 'LLM',
        connection,
        audioPlayer,
        realtime,
        releasePowerLock,
        state,
        inputStream: null,
        decoder: null,
        outputStream: null,
        inputAudioMs: 0,
        receivePackets: 0,
        outputAudioMs: 0,
        startedSpeaking: false,
        userJoinedChannel: member.voice.channelId === channel.id,
        presenceTimer: null,
        autoCommitTimer: null,
        idleTimer: null,
        durationTimer: null,
        ignoreNextResponseDone: false,
        ending: false,
      };
      this.attachVoiceConnectionDiagnostics(session);
      this.recordVoiceDebug(
        session,
        `created voice session; linked user ${maskDiscordId(discordUserId)}; user channel ${member.voice.channelId ?? 'none'}; bot connection ${connection.state.status}`,
        false
      );
      this.sessionsByPlayerId.set(player.id, session);
      this.sessionsByPower.set(power, session);
      this.sessionsByPower.set(player.power, session);
      this.startPresenceWatcher(session);
      session.durationTimer = setTimeout(
        () => void this.end(player.id),
        room.getState().settings.voiceMaxSessionMinutes * 60_000
      );
      this.resetIdleTimer(session);
      this.emit(session);
      if (member.voice.channelId === channel.id) {
        this.setStatus(session, 'READY');
        if (this.autoListenEnabled) void this.tryBeginAutoInput(session);
      }
    } catch (error) {
      provisioningRealtime?.close();
      provisioningConnection?.destroy();
      if (provisioningChannel) {
        await this.tryDeleteProvisioningChannel(provisioningChannel);
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
    if (session.kind !== 'LLM' || !session.realtime || !session.connection) {
      throw new Error('OpenAI voice input is only available when speaking with an LLM');
    }
    if (!['WAITING_FOR_USER', 'READY'].includes(session.state.status)) {
      throw new Error('Voice input cannot start in the current state');
    }
    const coordinator = this.bots.getCoordinatorClient();
    const guild = await coordinator?.guilds.fetch(session.channel.guildId);
    const member = await guild?.members.fetch(session.discordUserId);
    if (member && member.voice.channelId && member.voice.channelId !== session.channel.id) {
      await this.tryMoveMemberToChannel(member, session.channel);
    }
    if (!member || member.voice.channelId !== session.channel.id) {
      throw new Error('Join the temporary Discord voice channel first');
    }
    if (session.connection.state.status !== VoiceConnectionStatus.Ready) {
      throw new Error(
        `${session.power} voice bot is not connected yet (${session.connection.state.status}). End this session and start a new one.`
      );
    }

    const realtime = session.realtime;
    const connection = session.connection;
    realtime.clearInput();
    session.inputAudioMs = 0;
    session.receivePackets = 0;
    session.startedSpeaking = false;
    this.setStatus(session, 'LISTENING');
    this.recordVoiceDebug(session, `listen requested; ${this.voiceReceiveSnapshot(session)}`);
    this.attachInputStream(session, connection.receiver.subscribe(session.discordUserId, {
      end: { behavior: EndBehaviorType.Manual },
    }));
    const onSpeakingStart = (userId: string) => {
      if (userId !== session.discordUserId || !session.inputStream) return;
      session.startedSpeaking = true;
      this.emit(session);
      this.attachInputStream(session, connection.receiver.subscribe(session.discordUserId, {
        end: { behavior: EndBehaviorType.Manual },
      }));
    };
    connection.receiver.speaking.once('start', onSpeakingStart);
    session.inputStream?.once('close', () => {
      connection.receiver.speaking.off('start', onSpeakingStart);
    });
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });
    session.inputStream?.pipe(decoder);
    decoder.on('data', chunk => {
      if (session.state.status !== 'LISTENING') return;
      const audio = downsampleDiscordPcm(Buffer.from(chunk));
      session.receivePackets++;
      session.inputAudioMs += pcmDurationMs(audio, 24000, 1);
      realtime.appendAudio(audio);
      this.emit(session);
    });
    decoder.on('error', error => this.fail(session, error.message));
    session.decoder = decoder;
    this.resetIdleTimer(session);
  }

  commitInput(playerId: string): void {
    const session = this.requireSession(playerId);
    if (session.kind !== 'LLM' || !session.realtime) {
      throw new Error('OpenAI voice input is only available when speaking with an LLM');
    }
    if (session.state.status !== 'LISTENING') {
      throw new Error('The voice session is not listening');
    }
    const diagnosticsBeforeStop = this.voiceReceiveSnapshot(session);
    this.stopInput(session);
    if (session.inputAudioMs < 100) {
      const reason = session.startedSpeaking
        ? 'Discord reported that you were speaking, but no decodable audio reached the bot.'
        : 'Discord did not report any speech packets for your linked user.';
      const diagnostics = diagnosticsBeforeStop;
      this.recordVoiceDebug(session, `commit without audio; ${diagnostics}`);
      session.state = {
        ...session.state,
        error: this.debugEnabled
          ? `${reason} ${diagnostics}. Click Listen, make sure you are in the temporary channel and unmuted, speak for at least a moment, then click Done.`
          : `${reason} Make sure you are in the temporary channel and unmuted, then speak for at least a moment.`,
      };
      this.setStatus(session, 'READY');
      this.resetIdleTimer(session);
      return;
    }
    session.realtime.commitInput();
    this.setStatus(session, 'PROCESSING');
    this.resetIdleTimer(session);
  }

  interrupt(playerId: string): void {
    const session = this.requireSession(playerId);
    if (session.kind !== 'LLM' || !session.realtime || !session.audioPlayer) return;
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
    if (session.presenceTimer) clearInterval(session.presenceTimer);
    this.clearAutoCommitTimer(session);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.durationTimer) clearTimeout(session.durationTimer);
    session.realtime?.close();
    session.audioPlayer?.stop(true);
    session.connection?.destroy();
    session.releasePowerLock?.();
    this.sessionsByPlayerId.delete(session.player.id);
    if (session.targetPlayer) this.sessionsByPlayerId.delete(session.targetPlayer.id);
    this.sessionsByPower.delete(session.power);
    this.sessionsByPower.delete(session.player.power);
    await this.deleteVoiceChannel(session);
    this.emitIdle(session);
  }

  private writeOutputAudio(session: ActiveVoiceSession, audio: Buffer): void {
    if (!session.audioPlayer) return;
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
    session.outputAudioMs += pcmDurationMs(audio, 24000, 1);
    this.emit(session);
  }

  private async finishResponse(session: ActiveVoiceSession): Promise<void> {
    if (session.kind !== 'LLM') return;
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
    this.clearAutoCommitTimer(session);
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

  private startPresenceWatcher(session: ActiveVoiceSession): void {
    if (session.presenceTimer || session.kind !== 'LLM') return;
    session.presenceTimer = setInterval(
      () => void this.syncVoicePresence(session),
      1_000
    );
    session.presenceTimer.unref?.();
  }

  private async syncVoicePresence(session: ActiveVoiceSession): Promise<void> {
    if (session.ending || session.kind !== 'LLM') return;
    const coordinator = this.bots.getCoordinatorClient();
    const guild = await coordinator?.guilds.fetch(session.channel.guildId).catch(() => null);
    const member = await guild?.members.fetch(session.discordUserId).catch(() => null);
    if (!member) return;

    const inTemporaryChannel = member.voice.channelId === session.channel.id;
    if (!inTemporaryChannel) {
      if (
        session.userJoinedChannel &&
        ['WAITING_FOR_USER', 'READY', 'LISTENING', 'PROCESSING', 'SPEAKING', 'RECONCILING'].includes(session.state.status)
      ) {
        await this.end(session.player.id);
      }
      return;
    }

    session.userJoinedChannel = true;
    if (session.state.status === 'WAITING_FOR_USER') {
      this.setStatus(session, 'READY');
      if (this.autoListenEnabled) await this.tryBeginAutoInput(session);
    }
  }

  private async tryBeginAutoInput(session: ActiveVoiceSession): Promise<void> {
    if (
      !this.autoListenEnabled ||
      session.ending ||
      session.kind !== 'LLM' ||
      !['WAITING_FOR_USER', 'READY'].includes(session.state.status)
    ) {
      return;
    }
    try {
      await this.beginInput(session.player.id);
    } catch (error) {
      this.recordVoiceDebug(
        session,
        error instanceof Error ? `auto-listen skipped: ${error.message}` : 'auto-listen skipped'
      );
    }
  }

  private scheduleAutoCommit(session: ActiveVoiceSession): void {
    if (!this.autoListenEnabled || session.kind !== 'LLM') return;
    this.clearAutoCommitTimer(session);
    const delayMs = session.room.getState().settings.voiceAutoCommitSilenceSeconds * 1000;
    session.autoCommitTimer = setTimeout(() => {
      if (session.state.status !== 'LISTENING' || session.inputAudioMs < 100) return;
      try {
        this.commitInput(session.player.id);
      } catch (error) {
        this.recordVoiceDebug(
          session,
          error instanceof Error ? `auto-commit failed: ${error.message}` : 'auto-commit failed'
        );
      }
    }, delayMs);
    session.autoCommitTimer.unref?.();
  }

  private clearAutoCommitTimer(session: ActiveVoiceSession): void {
    if (!session.autoCommitTimer) return;
    clearTimeout(session.autoCommitTimer);
    session.autoCommitTimer = null;
  }

  private emit(session: ActiveVoiceSession): void {
    for (const player of this.sessionPlayers(session)) {
      this.emitState(session.room, player, this.stateForPlayer(session, player));
    }
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

  private async startHumanSession(
    room: GameRoom,
    player: HumanPlayer,
    power: Power
  ): Promise<void> {
    const targetPlayer = room.getState().players.find(
      (candidate): candidate is HumanPlayer =>
        candidate.kind === 'HUMAN' && candidate.power === power
    );
    if (!targetPlayer) throw new Error(`${power} is not an active human power`);
    if (this.sessionsByPlayerId.has(targetPlayer.id)) {
      throw new Error(`${power} is already in a voice conversation`);
    }

    const discordUserId = this.links.getDiscordUserId(player.id);
    const targetDiscordUserId = this.links.getDiscordUserId(targetPlayer.id);
    if (!discordUserId) throw new Error('Link your Discord account before starting voice');
    if (!targetDiscordUserId) throw new Error(`${power} has not linked a Discord account`);
    const coordinator = this.bots.getCoordinatorClient();
    if (!coordinator?.user) throw new Error('Discord coordinator bot is not connected');

    let provisioningChannel: VoiceChannel | null = null;
    try {
      this.emitState(room, player, {
        ...idleVoiceState(),
        sessionId: randomUUID(),
        status: 'PROVISIONING',
        power,
      });
      const guild = await coordinator.guilds.fetch(this.links.configuredGuildId!);
      const requesterMember = await guild.members.fetch(discordUserId);
      const targetMember = await guild.members.fetch(targetDiscordUserId);
      const coordinatorMember = await guild.members.fetch(coordinator.user.id);
      const channel = await guild.channels.create({
        name: `diplomacy-${player.power.toLowerCase()}-${power.toLowerCase()}`,
        type: ChannelType.GuildVoice,
        userLimit: 2,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          },
          {
            id: requesterMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.UseVAD,
            ],
          },
          {
            id: targetMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.UseVAD,
            ],
          },
          {
            id: coordinatorMember.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
          },
        ],
        reason: `Private Diplomacy player voice session for game ${room.gameId}`,
      });
      provisioningChannel = channel;
      await this.tryMoveMemberToChannel(requesterMember, channel);

      const sessionId = randomUUID();
      const state: VoiceSessionState = {
        sessionId,
        status: 'READY',
        power,
        channelId: channel.id,
        channelUrl: `https://discord.com/channels/${channel.guildId}/${channel.id}`,
        startedAt: new Date().toISOString(),
        turnCount: 0,
        maxTurns: 0,
        inputAudioMs: 0,
        receivePackets: 0,
        outputAudioMs: 0,
        debug: [],
        error: null,
      };
      const session: ActiveVoiceSession = {
        id: sessionId,
        room,
        player,
        targetPlayer,
        power,
        discordUserId,
        targetDiscordUserId,
        channel,
        kind: 'HUMAN',
        connection: null,
        audioPlayer: null,
        realtime: null,
        releasePowerLock: null,
        state,
        inputStream: null,
        decoder: null,
        outputStream: null,
        inputAudioMs: 0,
        receivePackets: 0,
        outputAudioMs: 0,
        startedSpeaking: false,
        userJoinedChannel: true,
        presenceTimer: null,
        autoCommitTimer: null,
        idleTimer: null,
        durationTimer: null,
        ignoreNextResponseDone: false,
        ending: false,
      };
      this.sessionsByPlayerId.set(player.id, session);
      this.sessionsByPlayerId.set(targetPlayer.id, session);
      this.sessionsByPower.set(player.power, session);
      this.sessionsByPower.set(power, session);
      session.durationTimer = setTimeout(
        () => void this.end(player.id),
        room.getState().settings.voiceMaxSessionMinutes * 60_000
      );
      this.emit(session);
    } catch (error) {
      if (provisioningChannel) {
        await this.tryDeleteProvisioningChannel(provisioningChannel);
      }
      this.emitState(room, player, {
        ...idleVoiceState(),
        status: 'FAILED',
        power,
        error: error instanceof Error ? error.message : 'Voice provisioning failed',
      });
      throw error;
    }
  }

  private sessionPlayers(session: ActiveVoiceSession): HumanPlayer[] {
    return session.targetPlayer
      ? [session.player, session.targetPlayer]
      : [session.player];
  }

  private stateForPlayer(
    session: ActiveVoiceSession,
    player: HumanPlayer
  ): VoiceSessionState {
    if (!session.targetPlayer || player.id === session.player.id) {
      return this.withVoiceDiagnostics(session.state, session);
    }
    return this.withVoiceDiagnostics({
      ...session.state,
      power: session.player.power,
    }, session);
  }

  private emitIdle(session: ActiveVoiceSession): void {
    for (const player of this.sessionPlayers(session)) {
      this.emitState(session.room, player, idleVoiceState());
    }
  }

  private async deleteVoiceChannel(session: ActiveVoiceSession): Promise<void> {
    const coordinator = this.bots.getCoordinatorClient();
    const attempts: Array<() => Promise<unknown>> = [];
    if (coordinator) {
      attempts.push(() =>
        coordinator.rest.delete(Routes.channel(session.channel.id), {
          reason: 'Diplomacy voice session ended',
        })
      );
    }
    const powerClient = this.bots.getPowerClient(session.power);
    if (powerClient) {
      attempts.push(() =>
        powerClient.rest.delete(Routes.channel(session.channel.id), {
          reason: 'Diplomacy voice session ended',
        })
      );
    }
    attempts.push(() => session.channel.delete('Diplomacy voice session ended'));

    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        await attempt();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    console.warn(`Could not delete voice channel ${session.channel.id}:`, lastError);
  }

  private async tryMoveMemberToChannel(
    member: GuildMember,
    channel: VoiceChannel
  ): Promise<void> {
    try {
      if (!member.voice.channelId) return;
      if (member.voice.channelId === channel.id) return;
      await member.voice.setChannel(channel, 'Diplomacy private voice session started');
    } catch (error) {
      if (discordErrorCode(error) === 50013) {
        console.info(
          `Could not move Discord member ${member.id} into voice channel ${channel.id}: missing permissions. The user may be the server owner or above the coordinator bot role.`
        );
        return;
      }
      console.warn(`Could not move Discord member ${member.id} into voice channel ${channel.id}:`, error);
    }
  }

  private async cleanupEmptyTemporaryChannels(): Promise<void> {
    const coordinator = this.bots.getCoordinatorClient();
    const guildId = this.links.configuredGuildId;
    if (!coordinator || !guildId) return;
    const guild = await coordinator.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return;
    for (const channel of channels.values()) {
      if (
        channel?.type !== ChannelType.GuildVoice ||
        !channel.name.startsWith('diplomacy-') ||
        channel.members.size > 0
      ) {
        continue;
      }
      await this.tryDeleteProvisioningChannel(channel);
    }
  }

  private async tryDeleteProvisioningChannel(channel: VoiceChannel): Promise<void> {
    const coordinator = this.bots.getCoordinatorClient();
    const attempts: Array<() => Promise<unknown>> = [];
    if (coordinator) {
      attempts.push(() =>
        coordinator.rest.delete(Routes.channel(channel.id), {
          reason: 'Voice session provisioning failed',
        })
      );
    }
    for (const power of ALL_POWERS) {
      const client = this.bots.getPowerClient(power);
      if (!client) continue;
      attempts.push(() =>
        client.rest.delete(Routes.channel(channel.id), {
          reason: 'Voice session provisioning failed',
        })
      );
    }
    attempts.push(() => channel.delete('Voice session provisioning failed'));

    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        await attempt();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    console.warn(`Could not delete failed voice channel ${channel.id}:`, lastError);
  }

  private attachInputStream(
    session: ActiveVoiceSession,
    inputStream: Readable
  ): void {
    if (session.inputStream === inputStream) return;
    session.inputStream?.unpipe(session.decoder ?? undefined);
    session.inputStream = inputStream;
    if (session.decoder) inputStream.pipe(session.decoder);
    this.recordVoiceDebug(session, `subscribed to user audio; ${this.voiceReceiveSnapshot(session)}`);
    inputStream.on('error', error => {
      this.recordVoiceDebug(
        session,
        error instanceof Error
          ? `audio receive stream error: ${error.message}`
          : 'audio receive stream error'
      );
      this.fail(
        session,
        error instanceof Error
          ? `Discord audio receive failed: ${error.message}`
          : 'Discord audio receive failed'
      );
    });
  }

  private withVoiceDiagnostics(
    state: VoiceSessionState,
    session: ActiveVoiceSession
  ): VoiceSessionState {
    return {
      ...state,
      inputAudioMs: Math.round(session.inputAudioMs),
      receivePackets: session.receivePackets,
      outputAudioMs: Math.round(session.outputAudioMs),
      debug: [...session.state.debug],
    };
  }

  private attachVoiceConnectionDiagnostics(session: ActiveVoiceSession): void {
    const connection = session.connection;
    if (!connection) return;

    connection.on('stateChange', (oldState, newState) => {
      this.recordVoiceDebug(
        session,
        `voice connection ${oldState.status} -> ${newState.status}; ${this.voiceReceiveSnapshot(session)}`
      );
    });
    connection.on('debug', message => {
      this.recordVoiceDebug(session, `voice debug: ${message}`);
    });
    connection.on('error', error => {
      this.recordVoiceDebug(session, `voice connection error: ${error.message}`);
    });
    connection.receiver.speaking.on('start', userId => {
      const target = userId === session.discordUserId ? 'target' : 'other';
      if (target === 'target') {
        session.startedSpeaking = true;
        this.clearAutoCommitTimer(session);
      }
      this.recordVoiceDebug(
        session,
        `speaking start from ${target} ${maskDiscordId(userId)}; ${this.voiceReceiveSnapshot(session)}`
      );
    });
    connection.receiver.speaking.on('end', userId => {
      const target = userId === session.discordUserId ? 'target' : 'other';
      if (target === 'target') this.scheduleAutoCommit(session);
      this.recordVoiceDebug(session, `speaking end from ${target} ${maskDiscordId(userId)}`);
    });
    connection.receiver.ssrcMap.on('create', data => {
      this.recordVoiceDebug(
        session,
        `ssrc create ${maskDiscordId(data.userId)} -> ${data.audioSSRC}`
      );
    });
    connection.receiver.ssrcMap.on('update', (_oldData, data) => {
      this.recordVoiceDebug(
        session,
        `ssrc update ${maskDiscordId(data.userId)} -> ${data.audioSSRC}`
      );
    });
    connection.receiver.ssrcMap.on('delete', data => {
      this.recordVoiceDebug(
        session,
        `ssrc delete ${maskDiscordId(data.userId)} -> ${data.audioSSRC}`
      );
    });
  }

  private recordVoiceDebug(
    session: ActiveVoiceSession,
    message: string,
    emit = true
  ): void {
    if (!this.debugEnabled) return;
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const debug = [...session.state.debug, `${timestamp} ${message}`].slice(-10);
    session.state = { ...session.state, debug };
    console.log(`[voice ${session.power} ${session.id.slice(0, 8)}] ${message}`);
    if (emit) this.emit(session);
  }

  private voiceReceiveSnapshot(session: ActiveVoiceSession): string {
    const connection = session.connection;
    if (!connection) return 'no voice connection';
    const ssrc = connection.receiver.ssrcMap.get(session.discordUserId);
    const speakingUsers = [...connection.receiver.speaking.users.keys()];
    return [
      `connection=${connection.state.status}`,
      `joinChannel=${connection.joinConfig.channelId}`,
      `targetChannel=${session.channel.id}`,
      `subscription=${connection.receiver.subscriptions.has(session.discordUserId) ? 'yes' : 'no'}`,
      `ssrc=${ssrc?.audioSSRC ?? 'none'}`,
      `speaking=${speakingUsers.length > 0 ? speakingUsers.map(maskDiscordId).join(',') : 'none'}`,
      `encryption=${getReceiverEncryptionMode(connection)}`,
    ].join('; ');
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
    inputAudioMs: 0,
    receivePackets: 0,
    outputAudioMs: 0,
    debug: [],
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

function pcmDurationMs(input: Buffer, sampleRate: number, channels: number): number {
  const bytesPerSample = 2;
  return input.length / bytesPerSample / channels / sampleRate * 1000;
}

function hashDiscordUserId(discordUserId: string): string {
  return createHash('sha256').update(discordUserId).digest('hex');
}

function getReceiverEncryptionMode(connection: VoiceConnection): string {
  const data = connection.receiver.connectionData as { encryptionMode?: string };
  return data.encryptionMode ?? 'none';
}

function maskDiscordId(discordUserId: string | undefined): string {
  if (!discordUserId) return 'unknown';
  return `...${discordUserId.slice(-4)}`;
}

function discordErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}
