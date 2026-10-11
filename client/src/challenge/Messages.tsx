import { useEffect, useRef, useState } from 'react';
import { ALL_POWERS, type ChatView, type Power } from '@diplomacy/shared';
import { title } from './text.js';

/**
 * Every conversation with the other powers, in one place: one private thread per power.
 * Each message gets one reply from that power's model, and it remembers the thread when it orders.
 */
export function MessagesView({ chat, human, busy, onSend }: { chat: ChatView; human: Power; busy: boolean; onSend: (power: Power, body: string) => Promise<void> }) {
  const opponents = ALL_POWERS.filter(power => power !== human);
  const [power, setPower] = useState<Power>(opponents[0]);
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const thread = chat.messages.filter(m => m.power === power), waiting = thread.some(m => m.reply === 'PENDING'), left = chat.limit - chat.used;
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [thread.length, power]);
  async function send() { const body = draft.trim(); if (!body) return; await onSend(power, body); setDraft(''); }
  return <main id="dip-content">
    <div className="dip-heading"><p className="dip-meta">Messages</p><h1>Talk to the <span>other powers</span></h1>
      <p>Private, one power at a time. They reply, remember what was said when they choose their orders, and may not keep their word. {left} of {chat.limit} messages left in this game.</p></div>
    <div className="dip-chat">
      <div className="dip-chat-powers" role="tablist" aria-label="Powers">{opponents.map(p => {
        const count = chat.messages.filter(m => m.power === p).length;
        return <button key={p} role="tab" aria-selected={p === power} onClick={() => setPower(p)}><span>{title(p)}</span>{count ? <span className="dip-small">{count}</span> : null}</button>;
      })}</div>
      <section aria-label={`Conversation with ${title(power)}`}>
        <h2>{title(power)}</h2>
        <div className="dip-thread" aria-live="polite" style={{ marginTop: 14 }}>
          {thread.length === 0 && <p className="dip-muted">No messages with {title(power)} yet.</p>}
          {thread.map(m => <div key={m.id} className={m.from === 'PLAYER' ? 'is-mine' : 'is-theirs'}>
            <strong className="dip-small">{m.from === 'PLAYER' ? 'You' : title(power)}</strong><p>{m.body}</p>
            {m.reply === 'PENDING' && <small>{title(power)} is replying…</small>}
            {m.reply === 'FAILED' && <small style={{ color: 'var(--folio-warning)' }}>No reply arrived. This message still counts; you can write again.</small>}
          </div>)}
          <div ref={end} />
        </div>
        {chat.canSend ? <form className="dip-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
          <label>Message to {title(power)}
            <textarea value={draft} maxLength={chat.maxLength} rows={3} disabled={busy || waiting || left <= 0} placeholder={left <= 0 ? 'You have used every message for this game.' : `Write to ${title(power)}…`} onChange={event => setDraft(event.target.value)} /></label>
          <div><button className="dip-solid" type="submit" disabled={busy || waiting || left <= 0 || !draft.trim()}>{busy || waiting ? 'Waiting for the reply…' : `Send to ${title(power)}`}</button></div>
        </form> : <p className="dip-muted dip-compose">You can send messages while you are choosing your orders.</p>}
      </section>
    </div>
  </main>;
}
