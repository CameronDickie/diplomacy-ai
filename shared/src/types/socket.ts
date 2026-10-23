import type { Power } from './game.js';
import type { TerritoryId, Coast } from './territory.js';
import type { Unit, UnitType } from './unit.js';
import type { Order, AdjudicationResult } from './order.js';
import type { GameState, Player } from './state.js';
import type { DiplomaticMessage } from './diplomacy.js';
import type {
  LlmFallbackCounters,
  LlmProviderId,
  LlmRunStatus,
  LlmRunSummary,
} from './llm.js';
import type { PublicPhaseReport } from './history.js';
import type {
  DiscordLinkStatus,
  ExpiringDiscordCode,
  VoiceSessionState,
} from './discord.js';

// ── Client → Server ──────────────────────────────────────────────────────────

export interface CreateGamePayload {
  playerName: string;
  preferredPower: Power | 'RANDOM';
}

export interface JoinGamePayload {
  gameId: string;
  playerName: string;
  preferredPower: Power | 'RANDOM';
}

export interface ResumeGamePayload {
  gameId: string;
  sessionToken: string;
}

export interface AddLlmPlayerPayload {
  gameId: string;
  power?: Power | 'RANDOM';
  name?: string;
  provider?: LlmProviderId;
  model?: string;
  persona?: string | null;
  realtimeModel?: string;
  voice?: string;
  voiceInstructions?: string | null;
}

export interface StartGamePayload {
  gameId: string;
}

export interface UpdateGameSettingsPayload {
  gameId: string;
  llmNegotiationInitiators?: number;
  llmNegotiationMaxMessages?: number;
  llmNegotiationWarningAtMessages?: number;
  llmNegotiationPlannerModel?: string;
  publicLlmConversationPresence?: boolean;
  voiceMaxSessionMinutes?: number;
  voiceMaxTurns?: number;
  voiceIdleTimeoutSeconds?: number;
  voiceAutoCommitSilenceSeconds?: number;
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
  clientMessageId: string;
  toPower: Power;
  body: string;
}

export interface SubmissionIdentity {
  phaseId: string;
  requestId: string;
}

export type PhaseSubmission = SubmissionIdentity & (
  | { phase: 'ORDERS'; orders: Order[] }
  | { phase: 'RETREATS'; retreats: SubmitRetreatsPayload['retreats'] }
  | { phase: 'BUILDS'; builds: SubmitBuildsPayload['builds']; disbands: string[] }
);

export interface SubmissionState {
  phaseId: string;
  requestId: string | null;
  status: 'EDITING' | 'SUBMITTING' | 'ACCEPTED' | 'FAILED';
  error: ErrorPayload | null;
}

export interface ClientToServerEvents {
  create_game: (payload: CreateGamePayload) => void;
  join_game: (payload: JoinGamePayload) => void;
  resume_game: (payload: ResumeGamePayload) => void;
  add_llm_player: (payload: AddLlmPlayerPayload) => void;
  update_game_settings: (payload: UpdateGameSettingsPayload) => void;
  start_game: (payload: StartGamePayload) => void;
  submit_orders: (payload: SubmitOrdersPayload & SubmissionIdentity) => void;
  submit_retreats: (payload: SubmitRetreatsPayload & SubmissionIdentity) => void;
  submit_builds: (payload: SubmitBuildsPayload & SubmissionIdentity) => void;
  send_diplomatic_message: (payload: SendDiplomaticMessagePayload) => void;
  request_diplomacy_history: (payload: { gameId: string }) => void;
  request_phase_history: (payload: { gameId: string }) => void;
  /** Every legal order for the asking player's units this phase, from the rules engine. */
  request_legal_orders: (payload: { gameId: string }) => void;
  create_discord_guild_bind_code: (payload: { gameId: string }) => void;
  create_discord_player_link_code: (payload: { gameId: string }) => void;
  request_discord_link_status: (payload: { gameId: string }) => void;
  start_voice_session: (payload: { gameId: string; toPower: Power }) => void;
  begin_voice_input: (payload: { gameId: string }) => void;
  commit_voice_input: (payload: { gameId: string }) => void;
  interrupt_voice_response: (payload: { gameId: string }) => void;
  end_voice_session: (payload: { gameId: string }) => void;
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

/** One order the rules engine allows, with the order itself, as the challenge's legal catalog has it. */
export interface LegalOrderChoice { id: string; unitTerritory: string; order: Order; description: string }
/** The player's legal orders for one phase of a hosted game. */
export interface LegalOrdersPayload { gameId: string; phaseId: string; power: Power; options: LegalOrderChoice[] }

export interface DiplomacyHistoryPayload {
  messages: DiplomaticMessage[];
}

export interface DiplomacyMessagePayload {
  message: DiplomaticMessage;
}

export interface PhaseHistoryPayload {
  reports: PublicPhaseReport[];
}

export interface PhaseReportAddedPayload {
  report: PublicPhaseReport;
}

export interface ConversationPresencePayload {
  active: boolean;
  status: 'IDLE' | 'WAITING_FOR_REPLY' | 'RESPONDING' | 'AT_MESSAGE_LIMIT';
  conversationId: string | null;
  participants: [Power, Power] | null;
  messageCount: number;
  maxMessages: number;
}

export interface LlmStatusPayload {
  power: Power;
  status: LlmRunStatus;
  purpose: 'DIPLOMACY' | 'ORDERS' | 'RETREATS' | 'BUILDS';
}

export interface LlmTelemetryPayload {
  run: LlmRunSummary;
  counters: LlmFallbackCounters;
}

export interface DiscordLinkStatusPayload {
  status: DiscordLinkStatus;
}

export interface DiscordCodeCreatedPayload {
  code: ExpiringDiscordCode;
}

export interface VoiceSessionStatePayload {
  state: VoiceSessionState;
}

export interface ServerToClientEvents {
  game_created: (payload: GameCreatedPayload) => void;
  game_joined: (payload: GameJoinedPayload) => void;
  game_resumed: (payload: GameResumedPayload) => void;
  session_replaced: (payload: ErrorPayload) => void;
  resume_error: (payload: ErrorPayload) => void;
  join_error: (payload: ErrorPayload) => void;
  player_joined: (payload: PlayerJoinedPayload) => void;
  player_disconnected: (payload: PlayerDisconnectedPayload) => void;
  game_started: (payload: GameStartedPayload) => void;
  game_state_sync: (payload: GameStateSyncPayload) => void;
  orders_acknowledged: (payload: OrdersAcknowledgedPayload) => void;
  submission_state: (payload: SubmissionState) => void;
  power_submitted: (payload: PowerSubmittedPayload) => void;
  turn_resolved: (payload: TurnResolvedPayload) => void;
  retreat_phase_start: (payload: RetreatPhasePayload) => void;
  build_phase_start: (payload: BuildPhasePayload) => void;
  game_over: (payload: GameOverPayload) => void;
  diplomacy_history: (payload: DiplomacyHistoryPayload) => void;
  diplomacy_message: (payload: DiplomacyMessagePayload) => void;
  phase_history: (payload: PhaseHistoryPayload) => void;
  legal_orders: (payload: LegalOrdersPayload) => void;
  phase_report_added: (payload: PhaseReportAddedPayload) => void;
  conversation_presence: (payload: ConversationPresencePayload) => void;
  llm_status: (payload: LlmStatusPayload) => void;
  llm_telemetry: (payload: LlmTelemetryPayload) => void;
  discord_link_status: (payload: DiscordLinkStatusPayload) => void;
  discord_guild_bind_code_created: (payload: DiscordCodeCreatedPayload) => void;
  discord_player_link_code_created: (payload: DiscordCodeCreatedPayload) => void;
  voice_session_state: (payload: VoiceSessionStatePayload) => void;
  error: (payload: ErrorPayload) => void;
}
