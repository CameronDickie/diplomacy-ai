import { withSocketAccess } from '../auth/socketPolicy.js';
import type { Socket } from 'socket.io';
import { ALL_POWERS, TERRITORY_MAP } from '@diplomacy/shared';
import type { ClientToServerEvents, ServerToClientEvents } from '@diplomacy/shared';

type Event = keyof ClientToServerEvents;
type Check = (value: unknown) => boolean;
const optional = (check: Check): Check => value => value === undefined || check(value);
const nullable = (check: Check): Check => value => value === null || check(value);
const text = (max: number, min = 0): Check => value =>
  typeof value === 'string' && value.length >= min && value.length <= max;
const oneOf = (values: readonly string[]): Check => value =>
  typeof value === 'string' && values.includes(value);
const boolean: Check = value => typeof value === 'boolean';
const number: Check = value => typeof value === 'number' && Number.isFinite(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (fields: Record<string, Check>): Check => value =>
  object(value) && Object.keys(value).every(key => Object.hasOwn(fields, key)) &&
  Object.entries(fields).every(([key, check]) => check(value[key]));
const array = (check: Check, max = 34): Check => value =>
  Array.isArray(value) && value.length <= max && value.every(check);
const power = oneOf(ALL_POWERS);
const preferredPower = optional(oneOf([...ALL_POWERS, 'RANDOM']));
const territory: Check = value => typeof value === 'string' && Object.hasOwn(TERRITORY_MAP, value);
const coast = nullable(oneOf(['NORTH', 'SOUTH', 'EAST', 'WEST']));
const gameId = text(64, 1);
const identifier = text(128, 1);
const phaseId = text(128, 1);
const game = { gameId };
const order: Check = value => shape({
  id: identifier,
  power,
  unitTerritory: territory,
  unitCoast: coast,
  type: oneOf(['HOLD', 'MOVE', 'SUPPORT_HOLD', 'SUPPORT_MOVE', 'CONVOY']),
  targetTerritory: nullable(territory),
  targetCoast: coast,
  supportedUnit: nullable(territory),
  supportedDestination: nullable(territory),
  viaConvoy: optional(boolean),
})(value) && object(value) &&
  (!['MOVE', 'CONVOY'].includes(String(value.type)) || territory(value.targetTerritory)) &&
  (!['SUPPORT_HOLD', 'SUPPORT_MOVE', 'CONVOY'].includes(String(value.type)) || territory(value.supportedUnit)) &&
  (value.type !== 'SUPPORT_MOVE' || territory(value.supportedDestination));
const retreat = nullable(shape({ territory, coast }));

// Keep the registry exhaustive: adding a transport event requires a validator.
const validators: Record<Event, Check> = {
  create_game: shape({ playerName: text(40), preferredPower }),
  join_game: shape({ ...game, playerName: text(40), preferredPower }),
  resume_game: shape({ ...game, sessionToken: identifier }),
  add_llm_player: shape({
    ...game,
    power: preferredPower,
    name: optional(text(40)),
    provider: optional(oneOf(['STUB', 'OPENAI', 'GEMINI', 'ANTHROPIC', 'OPENROUTER', 'OLLAMA'])),
    model: optional(text(100)),
    persona: optional(nullable(text(4000))),
    realtimeModel: optional(text(100)),
    voice: optional(text(100)),
    voiceInstructions: optional(nullable(text(4000))),
  }),
  update_game_settings: shape({
    ...game,
    llmNegotiationInitiators: optional(number),
    llmNegotiationMaxMessages: optional(number),
    llmNegotiationWarningAtMessages: optional(number),
    llmNegotiationPlannerModel: optional(text(100)),
    publicLlmConversationPresence: optional(boolean),
    voiceMaxSessionMinutes: optional(number),
    voiceMaxTurns: optional(number),
    voiceIdleTimeoutSeconds: optional(number),
    voiceAutoCommitSilenceSeconds: optional(number),
  }),
  start_game: shape(game),
  submit_orders: shape({ ...game, phaseId, requestId: identifier, orders: array(order) }),
  submit_retreats: shape({
    ...game, phaseId, requestId: identifier,
    retreats: value => object(value) && Object.keys(value).length <= 34 &&
      Object.entries(value).every(([key, destination]) => identifier(key) && retreat(destination)),
  }),
  submit_builds: shape({
    ...game, phaseId, requestId: identifier,
    builds: array(shape({ type: oneOf(['ARMY', 'FLEET']), territory, coast })),
    disbands: array(identifier),
  }),
  send_diplomatic_message: shape({
    ...game,
    clientMessageId: value => typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    toPower: power,
    body: text(2000, 1),
  }),
  request_diplomacy_history: shape(game),
  request_phase_history: shape(game),
  request_legal_orders: shape(game),
  create_discord_guild_bind_code: shape(game),
  create_discord_player_link_code: shape(game),
  request_discord_link_status: shape(game),
  start_voice_session: shape({ ...game, toPower: power }),
  begin_voice_input: shape(game),
  commit_voice_input: shape(game),
  interrupt_voice_response: shape(game),
  end_voice_session: shape(game),
  request_state: value => value === undefined,
};

export function onClientEvent<E extends Event>(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  event: E,
  handler: (payload: Parameters<ClientToServerEvents[E]>[0]) => void | Promise<void>
): void {
  const register = socket.on.bind(socket) as (
    event: E, listener: (payload: unknown) => Promise<void>
  ) => unknown;
  register(event, async raw => {
    const errorEvent = event === 'join_game' ? 'join_error'
      : event === 'resume_game' ? 'resume_error' : 'error';
    try {
      if (!validators[event](raw)) {
        socket.emit(errorEvent, {
          code: 'INVALID_PAYLOAD',
          message: `Invalid ${event.replaceAll('_', ' ')} request. Refresh the page and try again.`,
        });
        return;
      }
      await withSocketAccess(socket, event, () => handler(raw as Parameters<ClientToServerEvents[E]>[0]));
    } catch (error) {
      // Never log raw commands: they may contain private press or session tokens.
      console.error(`Client event ${event} failed:`, error instanceof Error ? error.name : 'Unknown error');
      socket.emit(errorEvent, {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed. Refresh the game state and try again.',
      });
    }
  });
}
