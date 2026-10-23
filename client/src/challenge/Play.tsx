import { useState } from 'react';
import type { ChallengeAttemptView, ChallengeCard, ChallengeLimits } from '@diplomacy/shared';
import type { useChallenge } from '../hooks/useChallenge.js';
import { territoryName } from '../lib/game.js';
import { ArrowFillButton } from './Shell.js';
import { describeOrder, phaseTitle, title } from './text.js';
import { OrderControls, adjustmentsReady } from './OrderControls.js';
import type { OrderEntry } from './useOrderEntry.js';

type Game = ReturnType<typeof useChallenge>;

/** The current turn: the map beside the orders being chosen for it, and nothing else. */
export function PlayView({ game, attempt, card, entry, clock, map, onHistory, onSetup }: {
  game: Game; attempt: ChallengeAttemptView; card: ChallengeCard; entry: OrderEntry; clock: number; map: React.ReactNode; onHistory: () => void; onSetup: () => void;
}) {
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const a = attempt, live = a.lifecycle === 'ACTIVE', activity = () => void game.activity();
  const last = [...game.reports].reverse().find(r => r.phase === 'ORDERS');
  const lastOwn = last?.phase === 'ORDERS' ? last.resolvedOrders.filter(o => o.power === card.humanPower) : [];
  const failed = lastOwn.filter(o => o.resolution !== 'SUCCEEDS').length;
  const kind = a.mode === 'SPONSORED' ? (game.sponsoredMock ? 'Mock model opponents' : game.sponsoredLive ? 'Live playtest · real model calls' : 'Sponsored · GPT-6 Luna opponents') : a.mode === 'BOT' ? 'Practice bot' : 'Controls practice';
  return <main id="dip-content" className="dip-play">
    <section className="dip-map" aria-label="Challenge board">{map}<a className="dip-map-credit" href="/legal.html">Map: Godip contributors · GPL-3.0</a></section>
    <aside aria-label="Your orders">
      <div className="dip-turn">
        <p className="dip-meta" aria-label="Opponents">{kind}</p>
        <h2 aria-label="Current phase">{live ? phaseTitle(a.board) : 'Game over'}</h2>
        <Objective card={card} board={a.board} live={live} />
        <p className="dip-muted dip-small" style={{ marginTop: 6 }}>{a.challenge.opponentLabel}.</p>
      </div>
      {!live ? <>
        <Outcome attempt={a} limits={game.limits} />
        <div className="dip-orders-actions"><button className="dip-solid" onClick={onHistory}>Review the game</button><button className="dip-link" onClick={onSetup}>Back to setup</button></div>
      </> : <>
        <p role="status" className="dip-small">{a.execution === 'ACCEPTING' ? (entry.nothingToDo ? nothing(a.board.phase) : instruction(a.board.phase))
          : a.execution !== 'RECOVERING' ? (a.mode === 'SPONSORED' ? 'Your orders are saved. The opponents are deciding…' : 'Your orders are saved. Resolving this turn…') : 'Your orders are saved. This turn is waiting; see below.'}</p>
        {clock >= a.idleWarnAt && <div className="dip-notice">Your game expires after inactivity. <button onClick={() => void game.activity(true)}>I’m still here</button></div>}
        {a.acceptedAction && a.execution !== 'ACCEPTING' && <div><p className="dip-small dip-muted">Submitted for this turn:</p>{a.acceptedAction.phase === 'ORDERS' && <ul className="dip-small">{a.acceptedAction.orderIds.map(id => <li key={id}>{describeOrder(id)}</li>)}</ul>}</div>}
        <OrderControls entry={entry} power={card.humanPower} legalReady={Boolean(game.legal)} loading={a.execution === 'ACCEPTING' ? 'Loading legal choices…' : 'Orders saved'}
          disabled={!entry.editable} legalError={game.legalError || null} onRetryLegal={game.busy ? undefined : game.retryLegal} onActivity={activity} />
        {a.execution === 'RECOVERING' && <div className="dip-notice is-error" role="alert" style={{ marginTop: 12 }}>
          <strong>{a.notice === 'SPONSORED_PAUSED' ? 'Sponsored play is paused' : a.notice === 'ATTEMPT_BUDGET' ? 'This game has used its sponsored budget' : a.notice === 'SPONSORED_RETRY' ? 'The turn is waiting on an opponent' : 'This turn needs recovery'}</strong>
          <p>Your orders are saved. {a.notice === 'ATTEMPT_BUDGET' ? 'It cannot continue; you can end it and review what happened.' : a.notice === 'SPONSORED_PAUSED' ? 'It continues when play resumes.' : 'Nothing is lost; trying again asks only for what is missing.'}</p>
          {a.noticeDetail && <ul>{a.noticeDetail.map(line => <li key={line}>{line}</li>)}</ul>}
          {a.notice !== 'ATTEMPT_BUDGET' && <button className="dip-solid" onClick={() => void game.recover()} disabled={game.busy || a.notice === 'SPONSORED_PAUSED' && game.sponsoredPlay === 'PAUSED'}>{a.notice === 'SPONSORED_RETRY' ? 'Try again' : a.notice === 'SPONSORED_PAUSED' ? 'Continue when resumed' : 'Recover saved phase'}</button>}
        </div>}
        <div className="dip-orders-actions">
          <ArrowFillButton disabled={!entry.editable || !entry.complete || !adjustmentsReady(entry)} onClick={() => { const action = entry.submission(); if (action) void game.submit(action); }}>
            {game.busy ? 'Saving…' : a.execution !== 'ACCEPTING' ? 'Orders saved' : entry.nothingToDo ? 'Continue' : a.board.phase === 'RETREATS' ? 'Submit retreats' : a.board.phase === 'BUILDS' ? 'Submit adjustments' : 'Submit orders'}</ArrowFillButton>
        </div>
        {lastOwn.length > 0 && <p className="dip-small dip-muted" style={{ marginTop: 18 }}>Last turn: {lastOwn.length - failed} of your {lastOwn.length} orders succeeded{failed ? `, ${failed} did not` : ''}. <button className="dip-link" onClick={onHistory}>See the orders log</button></p>}
        <p style={{ marginTop: 18 }}>{confirmAbandon ? <span className="dip-notice" style={{ display: 'block' }}>End this game? Its saved result will remain available.<br />
          <button onClick={() => void game.abandon()} disabled={game.busy}>End attempt</button><button onClick={() => setConfirmAbandon(false)}>Keep playing</button></span>
          : <button className="dip-link dip-small" onClick={() => setConfirmAbandon(true)}>Abandon attempt</button>}</p>
      </>}
    </aside>
  </main>;
}
const instruction = (phase: string) => phase === 'ORDERS' ? 'Your move. Give each unit one order. The menus list what the rules allow; allowed does not mean it will succeed.'
  : phase === 'RETREATS' ? 'One of your units was dislodged. Choose where it retreats, or disband it.' : 'Match your units to your supply centers: build where you have gained, disband where you have lost.';
const nothing = (phase: string) => phase === 'RETREATS' ? 'Another power must retreat. None of your units is affected; continue to the next turn.'
  : phase === 'BUILDS' ? 'Other powers are adjusting their forces. Your count already matches; continue to the next turn.' : 'You have no units to order this turn.';

/** Where the objective stands on the board being shown; ownership only moves after a settled Fall. */
function Objective({ card, board, live }: { card: ChallengeCard; board: ChallengeCard['board']; live: boolean }) {
  const owner = board.territoryOwners[card.targetTerritory] ?? null, there = board.units.find(u => u.territory === card.targetTerritory);
  const falls = Math.max(0, card.deadlineYear - board.year + (board.season === 'WINTER' ? 0 : 1));
  return <p className="dip-objective" role="status"><strong>{territoryName(card.targetTerritory)}</strong>: {owner === card.humanPower ? 'yours' : owner ? `owned by ${title(owner)}` : 'unowned'}{there ? `, ${there.power === card.humanPower ? 'your' : `${title(there.power)}’s`} ${there.type.toLowerCase()} is there` : ''}.
    {live && <> {falls === 0 ? 'The deadline has passed.' : `${falls} Fall turn${falls === 1 ? '' : 's'} left, through Fall ${card.deadlineYear}.`}</>}</p>;
}
export function Outcome({ attempt, limits }: { attempt: ChallengeAttemptView; limits: ChallengeLimits | null }) {
  const score = attempt.score;
  return <section className="dip-notice" aria-label="Attempt result" style={{ color: score?.outcome === 'SUCCESS' ? 'var(--folio-success)' : undefined }}>
    <strong>{score?.outcome === 'SUCCESS' ? 'Objective complete' : attempt.lifecycle === 'EXPIRED' ? 'Attempt expired' : attempt.lifecycle === 'ABANDONED' ? 'Attempt abandoned' : score?.outcome === 'FAILURE' ? 'Challenge finished' : 'Attempt stopped'}</strong>
    {score?.completedYear && <p>Fall {score.completedYear}{score.achievementIds.includes('EARLY_CAPTURE') ? ' · Achievement: Early capture' : ''}</p>}
    {attempt.lifecycle === 'EXPIRED' && <p>It closed after {limits ? `${limits.idleExpireMinutes} minutes` : 'a period'} without an action from you and cannot be resumed. You can start a new game if you have starts left today.</p>}
    {attempt.lifecycle === 'STOPPED' && <p>The site operator closed this game.</p>}
    <p>{attempt.mode === 'SPONSORED' ? 'This was a game against model opponents.' : attempt.mode === 'BOT' ? 'This was practice against the scripted bot.' : 'This was controls practice.'} Its turns are saved{limits ? ` for ${limits.resultRetentionDays} days` : ''}.</p></section>;
}
