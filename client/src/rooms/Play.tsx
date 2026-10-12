import type { ReactNode } from 'react';
import { ALL_POWERS, type GameState, type Order, type Power, type TerritoryId, type Unit } from '@diplomacy/shared';
import type { useGameSocket } from '../hooks/useGameSocket.js';
import { POWER_COLORS } from '../lib/game.js';
import { phaseTitle, title } from '../challenge/text.js';
import { Orders } from './Orders.js';

type GameSocket = ReturnType<typeof useGameSocket>;

/** What each power is doing this turn, as far as everyone is allowed to know. */
export function powerStatus(game: GameSocket, state: GameState, power: Power): string {
  const voice = game.voiceSession.power === power ? game.voiceSession.status : null;
  if (voice && !['IDLE', 'ENDING'].includes(voice)) return voice === 'LISTENING' ? 'Listening on voice' : 'On a voice call';
  if (game.conversationPresence.participants?.includes(power)) return 'In conversation';
  if (!state.units.some(unit => unit.power === power && !unit.mustRetreat)) return 'No units';
  if (state.status !== 'IN_PROGRESS') return '';
  return state.submittedPowers.includes(power) ? 'Submitted' : 'Deciding';
}
export const centers = (state: GameState, power: Power) => Object.values(state.territories).filter(t => t.isSupplyCenter && t.owner === power).length;

/** The current turn of a hosted game: the map beside your orders, and who the turn is waiting on. */
export function PlayView({ game, state, map, selectedUnit, pendingOrders, onSelectTerritory, onPendingOrdersChange, onSubmitOrders, onGame, onHistory }: {
  game: GameSocket; state: GameState; map: ReactNode; selectedUnit: Unit | null; pendingOrders: Order[];
  onSelectTerritory: (territory: TerritoryId | null) => void; onPendingOrdersChange: (orders: Order[]) => void; onSubmitOrders: () => void; onGame: () => void; onHistory: () => void;
}) {
  const over = state.status === 'FINISHED', me = game.myPower;
  return <main id="dip-content" className="dip-play">
    <section className="dip-map" aria-label="Game board">{map}</section>
    <aside aria-label="Your orders">
      <div className="dip-turn">
        <p className="dip-meta">Game {state.gameId}{me ? ` · you are ${title(me)}` : ' · watching'}{game.connection === 'connected' ? '' : ` · ${game.connection}`}</p>
        <h2 aria-label="Current phase">{over ? 'Game over' : phaseTitle(state)}</h2>
        {over ? <p className="dip-objective">{state.winner ? <><strong>{title(state.winner)}</strong> won the game.</> : 'The game has ended.'}</p>
          : <p className="dip-objective">{state.phase === 'ORDERS' ? 'Give each of your units one order. Click a unit on the map and then a destination, or use the list below.'
            : state.phase === 'RETREATS' ? 'Dislodged units retreat or disband.' : 'Each power matches its units to its supply centers.'}</p>}
      </div>
      {over ? <div className="dip-orders-actions"><button className="dip-solid" onClick={onHistory}>Review the game</button><button className="dip-link" onClick={onGame}>Game details</button></div>
        : me ? <Orders submission={game.submission} gameState={state} myPower={me} selectedUnit={selectedUnit} pendingOrders={pendingOrders}
            onSelectTerritory={onSelectTerritory} onPendingOrdersChange={onPendingOrdersChange} onSubmitOrders={onSubmitOrders}
            onSubmitRetreats={game.submitRetreats} onSubmitBuilds={game.submitBuilds} />
        : <p className="dip-muted">You do not have a seat in this game.</p>}
      <section className="dip-powers" aria-label="Powers this turn">
        <h3>Powers</h3>
        <ul className="dip-list">{ALL_POWERS.map(power => <li key={power}>
          <span><i className="dip-swatch" style={{ background: POWER_COLORS[power] }} aria-hidden="true" />{title(power)}{power === me ? ' (you)' : ''}</span>
          <span className="dip-small dip-muted">{centers(state, power)} center{centers(state, power) === 1 ? '' : 's'}{powerStatus(game, state, power) ? ` · ${powerStatus(game, state, power)}` : ''}</span></li>)}</ul>
        <p className="dip-small" style={{ marginTop: 10 }}><button className="dip-link" onClick={onGame}>Players and game details</button></p>
      </section>
    </aside>
  </main>;
}
