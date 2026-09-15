import { useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AddLlmPlayerPayload,
  ClientToServerEvents,
  ConversationPresencePayload,
  DiscordLinkStatus,
  DiplomaticMessage,
  ExpiringDiscordCode,
  GameSettings,
  GameState,
  LlmRunStatus,
  Order,
  Power,
  PublicPhaseReport,
  RetreatDestination,
  ServerToClientEvents,
  SubmitBuildsPayload,
  TerritoryId,
  VoiceSessionState,
} from '@diplomacy/shared';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const SESSION_KEY = 'diplomacy.playerSession';

interface SavedSession {
  gameId: string;
  playerId: string;
  sessionToken: string;
}

export interface LogEntry {
  id: string;
  at: string;
  kind: 'incoming' | 'outgoing' | 'system' | 'error';
  event: string;
  detail: string;
}

function now(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

export function useGameSocket() {
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [connection, setConnection] = useState('connecting');
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [myPower, setMyPower] = useState<Power | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [diplomaticMessages, setDiplomaticMessages] = useState<DiplomaticMessage[]>([]);
  const [phaseHistory, setPhaseHistory] = useState<PublicPhaseReport[]>([]);
  const [llmStatuses, setLlmStatuses] = useState<
    Partial<Record<Power, LlmRunStatus>>
  >({});
  const [conversationPresence, setConversationPresence] =
    useState<ConversationPresencePayload>({
      active: false,
      status: 'IDLE',
      conversationId: null,
      participants: null,
      messageCount: 0,
      maxMessages: 0,
    });
  const [discordStatus, setDiscordStatus] = useState<DiscordLinkStatus>({
    configured: false,
    voiceEnabled: false,
    guildBound: false,
    linked: false,
    discordDisplayName: null,
    powerBotAvailability: {},
  });
  const [discordGuildBindCode, setDiscordGuildBindCode] =
    useState<ExpiringDiscordCode | null>(null);
  const [discordPlayerLinkCode, setDiscordPlayerLinkCode] =
    useState<ExpiringDiscordCode | null>(null);
  const [voiceSession, setVoiceSession] = useState<VoiceSessionState>({
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
  });

  function log(kind: LogEntry['kind'], event: string, detail: unknown = '') {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    setLogs(entries => [{ id: crypto.randomUUID(), at: now(), kind, event, detail: text }, ...entries].slice(0, 200));
  }

  useEffect(() => {
    const nextSocket = io(import.meta.env.VITE_SERVER_URL || undefined, {
      withCredentials: true,
    }) as AppSocket;
    setSocket(nextSocket);

    nextSocket.on('connect', () => {
      setConnection('connected');
      log('system', 'connect', nextSocket.id);
      const savedSession = readSavedSession();
      if (savedSession) {
        nextSocket.emit('resume_game', {
          gameId: savedSession.gameId,
          sessionToken: savedSession.sessionToken,
        });
      }
    });
    nextSocket.on('disconnect', reason => {
      setConnection('disconnected');
      log('system', 'disconnect', reason);
    });
    nextSocket.on('connect_error', error => {
      setConnection('error');
      log('error', 'connect_error', error.message);
    });
    nextSocket.on('game_created', payload => {
      setGameId(payload.gameId);
      setMyPlayerId(payload.playerId);
      setMyPower(payload.power);
      setGameState(payload.gameState);
      setDiplomaticMessages([]);
      setPhaseHistory([]);
      saveSession(payload);
      nextSocket.emit('request_discord_link_status', { gameId: payload.gameId });
      log('incoming', 'game_created', { gameId: payload.gameId, power: payload.power });
    });
    nextSocket.on('game_joined', payload => {
      setGameId(payload.gameId);
      setMyPlayerId(payload.playerId);
      setMyPower(payload.power);
      setGameState(payload.gameState);
      setDiplomaticMessages([]);
      setPhaseHistory([]);
      saveSession(payload);
      nextSocket.emit('request_discord_link_status', { gameId: payload.gameId });
      log('incoming', 'game_joined', { power: payload.power });
    });
    nextSocket.on('game_resumed', payload => {
      setGameId(payload.gameId);
      setMyPlayerId(payload.playerId);
      setMyPower(payload.power);
      setGameState(payload.gameState);
      setPhaseHistory([]);
      nextSocket.emit('request_discord_link_status', { gameId: payload.gameId });
      log('incoming', 'game_resumed', { gameId: payload.gameId, power: payload.power });
    });
    nextSocket.on('resume_error', payload => {
      localStorage.removeItem(SESSION_KEY);
      log('error', 'resume_error', payload);
    });
    nextSocket.on('join_error', payload => log('error', 'join_error', payload));
    nextSocket.on('player_joined', payload => {
      setGameState(state => {
        if (!state) return state;
        nextSocket.emit('request_discord_link_status', { gameId: state.gameId });
        return { ...state, players: payload.allPlayers };
      });
      log('incoming', 'player_joined', `${payload.player.power} ${payload.player.kind}`);
    });
    nextSocket.on('player_disconnected', payload => {
      setGameState(state => state ? {
        ...state,
        players: state.players.map(player => player.kind === 'HUMAN' && player.power === payload.power ? { ...player, connected: false } : player),
      } : state);
      log('incoming', 'player_disconnected', payload.power);
    });
    nextSocket.on('game_started', payload => {
      setGameState(payload.gameState);
      log('incoming', 'game_started', payload.gameState.status);
    });
    nextSocket.on('game_state_sync', payload => {
      setGameState(payload.gameState);
      log('incoming', 'game_state_sync', `${payload.gameState.year} ${payload.gameState.season} ${payload.gameState.phase}`);
    });
    nextSocket.on('orders_acknowledged', payload => log('incoming', 'orders_acknowledged', `${payload.orders.length} orders`));
    nextSocket.on('power_submitted', payload => {
      setGameState(state => state && !state.submittedPowers.includes(payload.power)
        ? { ...state, submittedPowers: [...state.submittedPowers, payload.power] }
        : state
      );
      log('incoming', 'power_submitted', `${payload.power} ${payload.totalSubmitted}/${payload.totalRequired}`);
    });
    nextSocket.on('turn_resolved', payload => {
      setGameState(payload.newGameState);
      log('incoming', 'turn_resolved', `${payload.adjudicationResult.resolvedOrders.length} orders`);
    });
    nextSocket.on('retreat_phase_start', payload => {
      setGameState(payload.gameState);
      log('incoming', 'retreat_phase_start', `${payload.allDislodged.length} units`);
    });
    nextSocket.on('build_phase_start', payload => {
      setGameState(payload.gameState);
      log('incoming', 'build_phase_start', payload.buildCounts);
    });
    nextSocket.on('game_over', payload => {
      setGameState(payload.gameState);
      log('incoming', 'game_over', payload.winner);
    });
    nextSocket.on('diplomacy_history', payload => {
      setDiplomaticMessages(payload.messages);
      log('incoming', 'diplomacy_history', `${payload.messages.length} messages`);
    });
    nextSocket.on('diplomacy_message', ({ message }) => {
      setDiplomaticMessages(messages =>
        messages.some(candidate => candidate.id === message.id)
          ? messages
          : [...messages, message]
      );
    });
    nextSocket.on('phase_history', payload => {
      setPhaseHistory(payload.reports);
      log('incoming', 'phase_history', `${payload.reports.length} reports`);
    });
    nextSocket.on('phase_report_added', ({ report }) => {
      setPhaseHistory(reports =>
        reports.some(candidate => candidate.id === report.id)
          ? reports
          : [...reports, report]
      );
      log('incoming', 'phase_report_added', `${report.year} ${report.season} ${report.phase}`);
    });
    nextSocket.on('conversation_presence', payload => {
      setConversationPresence(payload);
      log(
        'incoming',
        'conversation_presence',
        payload.active
          ? `${payload.participants?.join(' / ') ?? 'private'} ${payload.messageCount}/${payload.maxMessages}`
          : 'idle'
      );
    });
    nextSocket.on('llm_status', payload => {
      setLlmStatuses(statuses => ({ ...statuses, [payload.power]: payload.status }));
      log('incoming', 'llm_status', `${payload.power} ${payload.status} ${payload.purpose}`);
    });
    nextSocket.on('llm_telemetry', ({ run, counters }) => {
      const fallback = run.fallbackReason
        ? `; fallback=${run.fallbackReason}`
        : '';
      log(
        run.outcome === 'FALLBACK' ? 'error' : 'incoming',
        'llm_run',
        `${run.power} ${run.purpose} ${run.provider}/${run.model} ${run.outcome}; ` +
        `${run.latencyMs}ms; retries=${run.retryCount}; ` +
        `game fallbacks=${counters.fallbackRuns}/${counters.totalRuns} ` +
        `(${(counters.fallbackRate * 100).toFixed(1)}%)${fallback}`
      );
    });
    nextSocket.on('discord_link_status', ({ status }) => {
      setDiscordStatus(status);
      log('incoming', 'discord_link_status', status);
    });
    nextSocket.on('discord_guild_bind_code_created', ({ code }) => {
      setDiscordGuildBindCode(code);
      log('incoming', 'discord_guild_bind_code_created', code.expiresAt);
    });
    nextSocket.on('discord_player_link_code_created', ({ code }) => {
      setDiscordPlayerLinkCode(code);
      log('incoming', 'discord_player_link_code_created', code.expiresAt);
    });
    nextSocket.on('voice_session_state', ({ state }) => {
      setVoiceSession(state);
      log('incoming', 'voice_session_state', `${state.power ?? '-'} ${state.status}`);
    });
    nextSocket.on('error', payload => log('error', payload.code, payload.message));

    const reconnectAfterAuth = () => {
      nextSocket.disconnect();
      nextSocket.connect();
    };
    window.addEventListener('diplomacy-auth-changed', reconnectAfterAuth);

    return () => {
      window.removeEventListener('diplomacy-auth-changed', reconnectAfterAuth);
      nextSocket.disconnect();
    };
  }, []);

  return useMemo(() => ({
    connection,
    gameState,
    gameId,
    myPlayerId,
    myPower,
    diplomaticMessages,
    phaseHistory,
    conversationPresence,
    discordStatus,
    discordGuildBindCode,
    discordPlayerLinkCode,
    voiceSession,
    llmStatuses,
    logs,
    createGame(playerName: string, preferredPower: Power | 'RANDOM') {
      socket?.emit('create_game', { playerName, preferredPower });
      log('outgoing', 'create_game', `${playerName} ${preferredPower}`);
    },
    joinGame(
      nextGameId: string,
      playerName: string,
      preferredPower: Power | 'RANDOM'
    ) {
      setGameId(nextGameId.trim().toUpperCase());
      socket?.emit('join_game', {
        gameId: nextGameId.trim().toUpperCase(),
        playerName,
        preferredPower,
      });
      log('outgoing', 'join_game', `${nextGameId} ${preferredPower}`);
    },
    addLlmPlayer(payload: Omit<AddLlmPlayerPayload, 'gameId'> = {}) {
      if (!gameId) return;
      socket?.emit('add_llm_player', { gameId, ...payload });
      log('outgoing', 'add_llm_player', payload);
    },
    updateGameSettings(settings: Partial<GameSettings>) {
      if (!gameId) return;
      socket?.emit('update_game_settings', {
        gameId,
        ...settings,
      });
      log('outgoing', 'update_game_settings', settings);
    },
    startGame() {
      if (!gameId) return;
      socket?.emit('start_game', { gameId });
      log('outgoing', 'start_game', gameId);
    },
    submitOrders(orders: Order[]) {
      if (!gameId) return;
      socket?.emit('submit_orders', { gameId, orders });
      log('outgoing', 'submit_orders', `${orders.length} orders`);
    },
    submitRetreats(retreats: Record<string, RetreatDestination | null>) {
      if (!gameId) return;
      socket?.emit('submit_retreats', { gameId, retreats });
      log('outgoing', 'submit_retreats', retreats);
    },
    submitBuilds(payload: Omit<SubmitBuildsPayload, 'gameId'>) {
      if (!gameId) return;
      socket?.emit('submit_builds', { gameId, ...payload });
      log('outgoing', 'submit_builds', payload);
    },
    sendDiplomaticMessage(toPower: Power, body: string) {
      if (!gameId || !myPower || !gameState) return;
      const clientMessageId = crypto.randomUUID();
      const message: DiplomaticMessage = {
        id: clientMessageId,
        gameId,
        fromPower: myPower,
        toPower,
        body: body.trim(),
        sentAt: new Date().toISOString(),
        year: gameState.year,
        season: gameState.season,
        phase: gameState.phase,
        automated: false,
        source: 'WEB',
        externalMessageId: null,
      };
      setDiplomaticMessages(messages => [...messages, message]);
      socket?.emit('send_diplomatic_message', {
        gameId,
        clientMessageId,
        toPower,
        body,
      });
    },
    createDiscordGuildBindCode() {
      if (!gameId) return;
      socket?.emit('create_discord_guild_bind_code', { gameId });
    },
    createDiscordPlayerLinkCode() {
      if (!gameId) return;
      socket?.emit('create_discord_player_link_code', { gameId });
    },
    refreshDiscordStatus() {
      if (!gameId) return;
      socket?.emit('request_discord_link_status', { gameId });
    },
    startVoiceSession(toPower: Power) {
      if (!gameId) return;
      socket?.emit('start_voice_session', { gameId, toPower });
    },
    beginVoiceInput() {
      if (!gameId) return;
      socket?.emit('begin_voice_input', { gameId });
    },
    commitVoiceInput() {
      if (!gameId) return;
      socket?.emit('commit_voice_input', { gameId });
    },
    interruptVoiceResponse() {
      if (!gameId) return;
      socket?.emit('interrupt_voice_response', { gameId });
    },
    endVoiceSession() {
      if (!gameId) return;
      socket?.emit('end_voice_session', { gameId });
    },
  }), [
    connection,
    conversationPresence,
    discordGuildBindCode,
    discordPlayerLinkCode,
    discordStatus,
    diplomaticMessages,
    phaseHistory,
    gameId,
    gameState,
    llmStatuses,
    logs,
    myPlayerId,
    myPower,
    socket,
    voiceSession,
  ]);
}

function readSavedSession(): SavedSession | null {
  try {
    const value = localStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) as SavedSession : null;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function saveSession(payload: SavedSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    gameId: payload.gameId,
    playerId: payload.playerId,
    sessionToken: payload.sessionToken,
  }));
}
