import { useEffect, useMemo, useRef, useState } from 'react';
import type { Power } from '@diplomacy/shared';
import type { useGameSocket } from '../hooks/useGameSocket.js';
import { title } from '../challenge/text.js';

type GameSocket = ReturnType<typeof useGameSocket>;
const PRESENCE = { IDLE: 'idle', WAITING_FOR_REPLY: 'waiting for a reply', RESPONDING: 'replying', AT_MESSAGE_LIMIT: 'message limit reached' } as const;

/** Every private conversation in a hosted game, one thread per power, in the same layout as the challenge. */
export function MessagesView({ game }: { game: GameSocket }) {
  const me = game.myPower;
  const between = (power: Power) => game.diplomaticMessages.filter(m => (m.fromPower === me && m.toPower === power) || (m.fromPower === power && m.toPower === me));
  const others = useMemo(() => (game.gameState?.players ?? []).filter(player => player.power !== me).sort((a, b) => a.power.localeCompare(b.power)), [game.gameState?.players, me]);
  const [chosen, setChosen] = useState<Power | null>(null);
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const power = chosen && others.some(player => player.power === chosen) ? chosen : others[0]?.power ?? null;
  const player = others.find(candidate => candidate.power === power);
  const thread = power ? between(power) : [];
  const presence = game.conversationPresence;
  const thinking = Boolean(power && me && player?.kind === 'LLM' && presence.participants?.includes(power) && presence.participants.includes(me)
    && ['THINKING', 'RETRYING'].includes(game.llmStatuses[power] ?? ''));
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [thread.length, power, thinking]);
  function send() { if (!power || !draft.trim()) return; game.sendDiplomaticMessage(power, draft); setDraft(''); }

  return <main id="dip-content">
    <div className="dip-heading"><p className="dip-meta">Messages</p><h1>Talk to the <span>other powers</span></h1>
      <p>Private, one power at a time. Nobody else in the game can read a thread, and nobody is bound by what they say in one.</p></div>
    {presence.active && <p className="dip-notice" role="status">{presence.participants ? `${presence.participants.map(title).join(' and ')} are talking` : 'AI powers are negotiating'} · {PRESENCE[presence.status]}
      {presence.maxMessages > 0 ? ` · ${presence.messageCount} of ${presence.maxMessages} messages` : ''}</p>}
    {!power ? <p className="dip-muted">Nobody else has joined this game yet.</p> : <div className="dip-chat">
      <div className="dip-chat-powers" role="tablist" aria-label="Powers">{others.map(other => {
        const count = between(other.power).length;
        return <button key={other.id} role="tab" aria-selected={other.power === power} onClick={() => setChosen(other.power)}>
          <span>{title(other.power)}<small className="dip-muted" style={{ display: 'block', fontWeight: 400 }}>{other.name}{other.kind !== 'LLM' ? '' : other.provider === 'STUB' ? (other.model === 'practice-bot-v1' ? ' · practice bot' : ' · offline bot') : ' · AI'}</small></span>{count ? <span className="dip-small">{count}</span> : null}</button>;
      })}</div>
      <section aria-label={`Conversation with ${title(power)}`}>
        <h2>{title(power)}</h2>
        <div className="dip-thread" aria-live="polite" style={{ marginTop: 14 }}>
          {thread.length === 0 && <p className="dip-muted">No messages with {title(power)} yet.</p>}
          {thread.map(m => <div key={m.id} className={m.fromPower === me ? 'is-mine' : 'is-theirs'}>
            <strong className="dip-small">{m.fromPower === me ? 'You' : title(m.fromPower)}</strong>
            <small> · {title(m.season)} {m.year}{m.automated ? ' · automated' : ''}{m.source !== 'WEB' ? ` · ${m.source === 'DISCORD_VOICE' ? 'voice' : 'Discord'}` : ''}</small>
            <p>{m.body}</p></div>)}
          {thinking && <div className="is-theirs"><small>{title(power)} is replying…</small></div>}
          <div ref={end} />
        </div>
        <form className="dip-compose" onSubmit={event => { event.preventDefault(); send(); }}>
          <label>Message to {title(power)}
            <textarea value={draft} maxLength={2000} rows={3} disabled={!game.gameId || !me} placeholder={`Write to ${title(power)}…`} onChange={event => setDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} /></label>
          <div><button className="dip-solid" type="submit" disabled={!draft.trim() || !me}>Send to {title(power)}</button></div>
        </form>
      </section>
    </div>}
  </main>;
}
