import type { Power } from './game.js';
import type { TerritoryId, Coast } from './territory.js';
import type { Unit, UnitType } from './unit.js';
import type { Order, AdjudicationResult } from './order.js';
import type { GameState, Player } from './state.js';
import type { DiplomaticMessage } from './diplomacy.js';

// ── Client → Server ──────────────────────────────────────────────────────────

export interface CreateGamePayload {
  playerName: string;
}

export interface JoinGamePayload {
  gameId: string;
  playerName: string;
}

export interface ResumeGamePayload {
  gameId: string;
  sessionToken: string;
}

export interface AddLlmPlayerPayload {
  gameId: string;
  name?: string;
  provider?: 'STUB' | 'OPENAI' | 'ANTHROPIC' | 'OPENROUTER' | 'OLLAMA';
  model?: string;
  persona?: string | null;
}

export interface StartGamePayload {
  gameId: string;
}

export interface SubmitOrdersPayload {
  gameId: string;
  orders: Order[];
}

export interface SubmitRetreatsPayload {
  gameId: string;
  /** unitId → retreat destination, or null to disband */
  retreats: Record<string, RetreatDestination | null>;
}

export interface RetreatDestination {
  territory: TerritoryId;
  coast: Coast | null;
}

export interface SubmitBuildsPayload {
  gameId: string;
  builds: Array<{ type: UnitType; territory: TerritoryId; coast: Coast | null }>;
  disbands: string[];
}

export interface SendDiplomaticMessagePayload {
  gameId: string;
  toPower: Power;
  body: string;
}

export interface ClientToServerEvents {
  create_game: (payload: CreateGamePayload) => void;
  join_game: (payload: JoinGamePayload) => void;
  resume_game: (payload: ResumeGamePayload) => void;
  add_llm_player: (payload: AddLlmPlayerPayload) => void;
  start_game: (payload: StartGamePayload) => void;
  submit_orders: (payload: SubmitOrdersPayload) => void;
  submit_retreats: (payload: SubmitRetreatsPayload) => void;
  submit_builds: (payload: SubmitBuildsPayload) => void;
  send_diplomatic_message: (payload: SendDiplomaticMessagePayload) => void;
  request_diplomacy_history: (payload: { gameId: string }) => void;
  request_state: () => void;
}

// ── Server → Client ──────────────────────────────────────────────────────────

export interface GameCreatedPayload {
  gameId: string;
  playerId: string;
  sessionToken: string;
  power: Power;
  gameState: GameState;
}

export interface GameJoinedPayload {
  gameId: string;
  playerId: string;
  sessionToken: string;
  power: Power;
  gameState: GameState;
}

export interface GameResumedPayload {
  gameId: string;
  playerId: string;
  power: Power;
  gameState: GameState;
}

export interface GameStateSyncPayload {
  gameState: GameState;
}

export interface OrdersAcknowledgedPayload {
  orders: Order[];
}

export interface PowerSubmittedPayload {
  power: Power;
  totalSubmitted: number;
  totalRequired: number;
}

export interface TurnResolvedPayload {
  adjudicationResult: AdjudicationResult;
  newGameState: GameState;
}

export interface RetreatPhasePayload {
  dislodgedUnits: Unit[];
  allDislodged: Unit[];
  gameState: GameState;
}

export interface BuildPhasePayload {
  buildCounts: Record<Power, number>;
  gameState: GameState;
}

export interface PlayerJoinedPayload {
  player: Player;
  allPlayers: Player[];
}

export interface GameStartedPayload {
  gameState: GameState;
}

export interface PlayerDisconnectedPayload {
  power: Power;
}

export interface GameOverPayload {
  winner: Power;
  gameState: GameState;
}

export interface ErrorPayload {
  message: string;
  code: string;
}

export interface DiplomacyHistoryPayload {
  messages: DiplomaticMessage[];
}

export interface DiplomacyMessagePayload {
  message: DiplomaticMessage;
}

export interface ServerToClientEvents {
  game_created: (payload: GameCreatedPayload) => void;
  game_joined: (payload: GameJoinedPayload) => void;
  game_resumed: (payload: GameResumedPayload) => void;
  resume_error: (payload: ErrorPayload) => void;
  join_error: (payload: ErrorPayload) => void;
  player_joined: (payload: PlayerJoinedPayload) => void;
  player_disconnected: (payload: PlayerDisconnectedPayload) => void;
  game_started: (payload: GameStartedPayload) => void;
  game_state_sync: (payload: GameStateSyncPayload) => void;
  orders_acknowledged: (payload: OrdersAcknowledgedPayload) => void;
  power_submitted: (payload: PowerSubmittedPayload) => void;
  turn_resolved: (payload: TurnResolvedPayload) => void;
  retreat_phase_start: (payload: RetreatPhasePayload) => void;
  build_phase_start: (payload: BuildPhasePayload) => void;
  game_over: (payload: GameOverPayload) => void;
  diplomacy_history: (payload: DiplomacyHistoryPayload) => void;
  diplomacy_message: (payload: DiplomacyMessagePayload) => void;
  error: (payload: ErrorPayload) => void;
}
