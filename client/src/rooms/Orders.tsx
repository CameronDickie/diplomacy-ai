import type { GameState, Power } from '@diplomacy/shared';
import { OrderControls, adjustmentsReady } from '../challenge/OrderControls.js';
import { ArrowFillButton } from '../challenge/Shell.js';
import { describeOrderFields, title } from '../challenge/text.js';
import type { OrderEntry } from '../challenge/useOrderEntry.js';
import type { useGameSocket } from '../hooks/useGameSocket.js';

type GameSocket = ReturnType<typeof useGameSocket>;

/**
 * This turn's decisions in a game with friends: the same controls as the daily challenge and the seat against
 * the AI (one menu per unit of every legal order, retreats, builds), then the room's own submit and who the
 * turn is still waiting on. Nothing is sent until Submit.
 */
export function Orders({ game, state, myPower, entry, legalReady, canDecide, onSubmit }: {
  game: GameSocket; state: GameState; myPower: Power; entry: OrderEntry; legalReady: boolean; canDecide: boolean; onSubmit: () => void;
}) {
  const submission = game.submission, phase = state.phase;
  const submitting = submission?.status === 'SUBMITTING';
  const submitted = submission?.status === 'ACCEPTED' || state.submittedPowers.includes(myPower);
  const activePowers = new Set(state.units.filter(unit => !unit.mustRetreat).map(unit => unit.power));
  const waitingHumans = state.players.filter(player => player.kind === 'HUMAN' && activePowers.has(player.power) && !state.submittedPowers.includes(player.power));
  const waitingOnAi = state.players.some(player => player.kind === 'LLM' && activePowers.has(player.power));
  const label = phase === 'RETREATS' ? 'retreats' : phase === 'BUILDS' ? 'adjustments' : 'orders';

  return <div className="room-orders">
    {submitting && <p role="status" className="dip-small">Submitting your {label}. Waiting for the server…</p>}
    {submission?.status === 'FAILED' && <p role="alert" className="dip-notice is-error">{submission.error?.message ?? 'Submission failed. Please retry.'}</p>}
    {submitted && <div className="dip-notice" role="status" style={{ color: 'var(--folio-success)' }}>
      <strong>{title(label)} submitted.</strong>{' '}
      {waitingHumans.length > 0 ? `Waiting for ${waitingHumans.map(player => title(player.power)).join(', ')}.`
        : waitingOnAi ? 'Waiting for the AI powers to finish.' : 'Resolving the turn.'}
    </div>}

    {/* What was sent, in words, while this page still knows it; after a reload the room says only that it was. */}
    {submission?.status === 'ACCEPTED' && phase === 'ORDERS' && entry.chosenOrders.length > 0 && <div>
      <p className="dip-small dip-muted">Submitted for this turn:</p>
      <ul className="dip-small">{entry.chosenOrders.map(order => <li key={order.id}>{describeOrderFields(order)}</li>)}</ul></div>}

    {entry.nothingToDo && !submitted ? <p className="dip-small dip-muted" role="status">
      {phase === 'RETREATS' ? 'None of your units has to retreat. Waiting for the powers that do.'
        : phase === 'BUILDS' ? 'Your units already match your supply centers. Waiting for the powers that build or disband.'
        : 'You have no units to order this turn.'}</p>
      : submitted && phase === 'ORDERS' ? null : <>
        <OrderControls entry={entry} power={myPower} legalReady={legalReady} loading={canDecide ? 'Loading legal orders…' : 'Orders submitted'}
          disabled={!canDecide} legalError={game.legalError} onRetryLegal={game.retryLegal} />
        {canDecide && <div className="dip-orders-actions">
          <ArrowFillButton onClick={onSubmit} disabled={submitting || !entry.complete || !adjustmentsReady(entry)}>
            {submitting ? 'Submitting…' : phase === 'RETREATS' ? 'Submit retreats' : phase === 'BUILDS' ? 'Submit adjustments' : 'Submit orders'}
          </ArrowFillButton>
        </div>}
      </>}
  </div>;
}
