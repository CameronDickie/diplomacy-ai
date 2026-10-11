import { useEffect, useState } from 'react';
import type { ChallengeCard, ChallengeLimits, ChallengeMode } from '@diplomacy/shared';
import type { useChallenge } from '../hooks/useChallenge.js';
import { territoryName } from '../lib/game.js';
import { ArrowFillButton } from './Shell.js';
import { phaseTitle, title, untilChange } from './text.js';

type Game = ReturnType<typeof useChallenge>;

/**
 * Before a game: what the challenge is, and the ways to play it set side by side so their
 * differences are plain. Past games, exhibition games and the account live here too.
 */
export function SetupView({ game, clock, map, onContinue, onWatchReference, onWatchExhibition }: {
  game: Game; clock: number; map: React.ReactNode; onContinue: () => void; onWatchReference: () => void; onWatchExhibition: (id: string, name: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [game.auth.user?.id]);
  const card = game.cards[0], active = game.attempt?.lifecycle === 'ACTIVE' ? game.attempt : null;
  const canStart = game.auth.authenticated && !game.busy && !!card && !active;
  const start = (mode: ChallengeMode) => { if (card) void game.start(card, mode); };
  const sponsoredName = game.sponsoredMock ? 'Mock model opponents' : game.sponsoredLive ? 'Live model opponents' : 'Luna opponents';
  const sponsoredButton = game.sponsoredMock ? 'Play against mock model opponents' : game.sponsoredLive ? 'Play a live playtest (real model calls)' : 'Play against Luna opponents';
  return <main id="dip-content">
    <div className="dip-setup">
      <div>
        <div className="dip-heading">
          <p className="dip-meta">{game.rotation ? `Development pilot · challenge ${game.rotation.index + 1} of ${game.rotation.size}` : 'Development pilot'}</p>
          <h1>{card ? <>{card.title.split(' ').slice(0, -1).join(' ')} <span>{card.title.split(' ').slice(-1)[0]}</span></> : 'Diplomacy challenges'}</h1>
          {card && <p>As {title(card.humanPower)}, own {territoryName(card.targetTerritory)} after Fall {card.deadlineYear} or sooner. Seven powers, one objective, and every order counts.</p>}
        </div>
        {card && <dl className="dip-facts" aria-label="Your mission">
          <div><dt>You play</dt><dd>{title(card.humanPower)}</dd></div>
          <div><dt>Objective</dt><dd>Own {territoryName(card.targetTerritory)}</dd></div>
          <div><dt>Deadline</dt><dd>Fall {card.deadlineYear}</dd></div>
          <div><dt>Early capture</dt><dd>By Fall {card.earlyAchievementYear}</dd></div>
        </dl>}
        <p className="dip-muted dip-small" style={{ marginTop: 20 }}>Ownership changes only after a Fall turn has fully settled. Moving in during Spring is not enough.</p>
        {game.rotation && <p className="dip-muted dip-small">The challenge changes at midnight UTC, in {untilChange(game.rotation.nextChangeAt, clock)}. A game keeps the challenge it started with.</p>}
      </div>
      <div className="dip-map" style={{ height: 'min(56dvh, 520px)', marginTop: 40 }}>{map}<a className="dip-map-credit" href="/legal.html">Map: Godip contributors · GPL-3.0</a></div>
    </div>

    {active && <div className="dip-notice" role="status" style={{ marginTop: 28 }}><strong>You have a game in progress</strong>
      <p>{active.challenge.title}, {phaseTitle(active.board)}. Finish or end it before starting another.</p>
      <button className="dip-solid" onClick={onContinue}>Continue playing</button></div>}
    {game.capacity === 'FULL' && !active && <p className="dip-notice" role="status">All {game.limits?.maxActiveAttempts} game slots are in use right now. There is no queue: try again in a few minutes, or watch the reference replay meanwhile.</p>}
    {game.sponsoredPlay === 'PAUSED' && <div className="dip-notice" role="status"><strong>Sponsored play against GPT-6 Luna is paused</strong><p>Practice and the replay still work.</p>
      {game.auth.authenticated && <button disabled={game.busy || game.creditRequested} onClick={() => void game.requestCredit()}>{game.creditRequested ? 'Request sent to the owner' : 'Ask the owner to resume it'}</button>}</div>}

    <section className="dip-section" aria-labelledby="dip-ways">
      <h2 id="dip-ways">Choose how to play</h2>
      <p className="dip-muted">The challenge and the rules are the same in each. What changes is who decides the other six powers’ moves. Every option is free to you and uses one of your daily starts.</p>
      {!game.auth.authenticated && <p className="dip-notice" role="status">Sign in with Google or GitHub to play; your game is saved to your account. The reference replay needs no account.</p>}
      <ol className="dip-modes">
        <li className="dip-mode"><span>01 · RECOMMENDED</span><h3>Practice bot</h3>
          <dl><dt>Opponents</dt><dd>Scripted: they head for supply centers and support each other</dd><dt>AI model</dt><dd>None</dd><dt>Messages</dt><dd>No</dd></dl>
          <p>A real game against opponents that move, with no AI involved. They play the same way for the same position and are not strong players. Start here.</p>
          <ArrowFillButton disabled={!canStart} onClick={() => start('BOT')}>Play against the practice bot</ArrowFillButton></li>
        <li className="dip-mode"><span>02</span><h3>Controls practice</h3>
          <dl><dt>Opponents</dt><dd>Every unit holds, every turn</dd><dt>AI model</dt><dd>None</dd><dt>Messages</dt><dd>No</dd></dl>
          <p>Nothing contests you. Use it to learn the order menus, the map and how a turn resolves, not to test yourself.</p>
          <button className="dip-solid" disabled={!canStart} onClick={() => start('PRACTICE')}>Start practice</button></li>
        {game.sponsoredPlay === 'OPEN' && <li className="dip-mode"><span>03{game.sponsoredLive ? ' · DEVELOPMENT' : game.sponsoredMock ? ' · STAND-IN' : ''}</span><h3>{sponsoredName}</h3>
          <dl><dt>Opponents</dt><dd>{game.sponsoredMock ? 'A stand-in that picks random legal orders' : 'Each power decided by an AI model'}</dd>
            <dt>AI model</dt><dd>{game.sponsoredMock ? 'None is called' : game.sponsoredLive ? 'Real calls from your local ledger' : 'GPT-6 Luna, paid for by the site owner'}</dd>
            <dt>Messages</dt><dd>{game.sponsoredChat ? 'Yes: talk to each power privately' : 'No'}</dd></dl>
          <p>{game.sponsoredMock ? 'Exercises the whole AI-opponent flow without calling a model. The moves say nothing about how a model plays.'
            : 'Opponents that plan for themselves. Play runs on a fixed budget: if it is paused or runs out you are told and your game waits with your orders saved. Model opponents are never silently swapped for practice ones.'}</p>
          <ArrowFillButton disabled={!canStart} onClick={() => start('SPONSORED')}>{sponsoredButton}</ArrowFillButton></li>}
      </ol>
      <p><button className="dip-link" onClick={onWatchReference} disabled={!game.demo}>Watch reference replay</button> <span className="dip-muted dip-small">— a recorded example run of this challenge. No account needed.</span></p>
    </section>

    {card && <Guide card={card} limits={game.limits} />}

    {game.history.length > 0 && <section className="dip-section" aria-labelledby="dip-games"><h2 id="dip-games">Your games</h2>
      <ul className="dip-list">{game.history.map(item => <li key={item.id}><span>{item.challenge.title}<small>{title(item.lifecycle)} · {title(item.board.season)} {item.board.year} · {item.mode === 'SPONSORED' ? 'model opponents' : item.mode === 'BOT' ? 'practice bot' : 'controls practice'}</small></span>
        <button className="dip-link" onClick={() => void game.resume(item.id)} disabled={game.busy}>{item.lifecycle === 'ACTIVE' ? 'Continue' : 'Review'}</button></li>)}</ul>
      {game.older && <p style={{ marginTop: 12 }}><button className="dip-link" onClick={() => void game.loadOlder()} disabled={game.busy}>Show older games</button></p>}</section>}

    {game.exhibitions.length > 0 && <section className="dip-section" aria-labelledby="dip-exhibitions"><h2 id="dip-exhibitions">Bot exhibition games</h2>
      <p className="dip-muted">All seven powers played by the practice bot. Watch one to see a longer game unfold.</p>
      <ul className="dip-list">{game.exhibitions.map(e => <li key={e.id}><span>{e.title}<small>{e.state === 'RUNNING' ? 'In progress' : e.state === 'PAUSED' ? 'Paused' : e.state === 'STALLED' ? 'Drawn' : e.state === 'COMPLETED' ? 'Finished' : e.state === 'CANCELLED' ? 'Cancelled' : 'Stopped'} · {e.phases} phases · {e.year} {e.season}</small></span>
        <button className="dip-link" disabled={e.phases === 0} onClick={() => onWatchExhibition(e.id, e.title)}>Watch</button></li>)}</ul></section>}

    {game.auth.authenticated && <section className="dip-section" aria-label="Your account"><h2>Your account</h2>
      {confirmDelete ? <div className="dip-notice is-error"><p>Delete your account? This signs you out and permanently removes your sign-in identity, any game in progress and all saved games. Today’s used starts still count if you sign in again.</p>
        <button onClick={() => void game.deleteAccount()} disabled={game.busy}>Delete account and data</button><button onClick={() => setConfirmDelete(false)}>Keep my account</button></div>
        : <button className="dip-link" onClick={() => setConfirmDelete(true)}>Delete account and data…</button>}</section>}
  </main>;
}

function Guide({ card, limits }: { card: ChallengeCard; limits: ChallengeLimits | null }) {
  const power = title(card.humanPower), n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return <section className="dip-section" aria-labelledby="dip-guide"><h2 id="dip-guide">How this challenge works</h2>
    <details open><summary>Goal and ending</summary>
      <p>You play {power}. You succeed the moment {power} owns the target supply center once a Fall turn has fully settled. If Fall {card.deadlineYear} settles without it, the challenge ends unsuccessfully.</p>
      <p>Supply centers change hands only after Fall. “Settled” means any retreats from that Fall have been resolved first, so a unit forced out of the center does not count.</p>
      <p>Finish by Fall {card.earlyAchievementYear} to also earn the Early capture achievement.</p></details>
    <details><summary>Legal is not successful</summary>
      <p>The order menus list only moves the rules engine allows. Whether an order succeeds depends on what every other power does in the same turn: a legal move can still bounce or be cut.</p>
      <p>You are only asked for input when you have a decision to make. Steps that ask nothing of you, such as another power’s retreat, are played through and appear in your history.</p></details>
    {limits && <details><summary>Limits</summary>
      <p>{n(limits.maxActivePerAccount, 'active game')} per account and {n(limits.dailyStartLimit, 'start')} per account per UTC day; an abandoned start still counts. The site runs at most {n(limits.maxActiveAttempts, 'game')} at once. There is no queue: if it is full, try again later.</p>
      <p>You are warned after {limits.idleWarnMinutes} minutes without an action and the game expires at {limits.idleExpireMinutes}. Only your own actions count; leaving the page open does not. Expired and finished games stay readable for {limits.resultRetentionDays} days, then are deleted.</p></details>}
    <details><summary>Privacy</summary>
      <p>Signing in stores your Google or GitHub account identifier and display name, and accounts are never linked by email. Your games are visible only to you. The site operator can view game boards, settled reports and capacity to run the service.</p>
      <p>You can delete your account at any time under “Your account”. That removes your identity, sessions and games; anonymous usage and cost records with no link to you are kept for accounting.</p>
      <p className="dip-muted">Development pilot: AI-generated test scenarios that rotate at midnight UTC so the rotation itself can be tested. A public daily schedule has not been announced.</p></details>
  </section>;
}
