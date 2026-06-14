import { useEffect, useMemo, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AddLlmPlayerPayload,
  ClientToServerEvents,
  DiplomaticMessage,
  GameState,
  Order,
  Power,
  RetreatDestination,
  ServerToClientEvents,
  SubmitBuildsPayload,
  TerritoryId,
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

  function log(kind: LogEntry['kind'], event: string, detail: unknown = '') {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    setLogs(entries => [{ id: crypto.randomUUID(), at: now(), kind, event, detail: text }, ...entries].slice(0, 200));
  }

  useEffect(() => {
    const nextSocket = io(import.meta.env.VITE_SERVER_URL || undefined) as AppSocket;
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
      saveSession(payload);
      log('incoming', 'game_created', { gameId: payload.gameId, power: payload.power });
    });
    nextSocket.on('game_joined', payload => {
      setGameId(payload.gameId);
      setMyPlayerId(payload.playerId);
      setMyPower(payload.power);
      setGameState(payload.gameState);
      setDiplomaticMessages([]);
      saveSession(payload);
      log('incoming', 'game_joined', { power: payload.power });
    });
    nextSocket.on('game_resumed', payload => {
      setGameId(payload.gameId);
      setMyPlayerId(payload.playerId);
      setMyPower(payload.power);
      setGameState(payload.gameState);
      log('incoming', 'game_resumed', { gameId: payload.gameId, power: payload.power });
    });
    nextSocket.on('resume_error', payload => {
      localStorage.removeItem(SESSION_KEY);
      log('error', 'resume_error', payload);
    });
    nextSocket.on('join_error', payload => log('error', 'join_error', payload));
    nextSocket.on('player_joined', payload => {
      setGameState(state => state ? { ...state, players: payload.allPlayers } : state);
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
    nextSocket.on('error', payload => log('error', payload.code, payload.message));

    return () => {
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
    logs,
    createGame(playerName: string) {
      socket?.emit('create_game', { playerName });
      log('outgoing', 'create_game', playerName);
    },
    joinGame(nextGameId: string, playerName: string) {
      setGameId(nextGameId.trim().toUpperCase());
      socket?.emit('join_game', { gameId: nextGameId.trim().toUpperCase(), playerName });
      log('outgoing', 'join_game', nextGameId);
    },
    addLlmPlayer(payload: Omit<AddLlmPlayerPayload, 'gameId'> = {}) {
      if (!gameId) return;
      socket?.emit('add_llm_player', { gameId, ...payload });
      log('outgoing', 'add_llm_player', payload);
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
      if (!gameId) return;
      socket?.emit('send_diplomatic_message', { gameId, toPower, body });
    },
  }), [
    connection,
    diplomaticMessages,
    gameId,
    gameState,
    logs,
    myPlayerId,
    myPower,
    socket,
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
