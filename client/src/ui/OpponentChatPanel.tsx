import { useEffect, useRef, useState } from 'react';
import { ALL_POWERS, type ChatView, type Power } from '@diplomacy/shared';

const name = (power: string) => power[0] + power.slice(1).toLowerCase();

/**
 * The player's private conversations with the opponent powers. One thread per power; each message
 * gets one reply from that power's model. Development playtests only.
 */
export function OpponentChatPanel({ chat, human, busy, onSend }: { chat: ChatView; human: Power; busy: boolean; onSend: (power: Power, body: string) => Promise<void> }) {
  const opponents = ALL_POWERS.filter(power => power !== human);
  const [power, setPower] = useState<Power>(opponents[0]);
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const thread = chat.messages.filter(m => m.power === power);
  const waiting = thread.some(m => m.reply === 'PENDING');
  const left = chat.limit - chat.used;
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [thread.length, power]);
  async function send() {
    const body = draft.trim();
    if (!body) return;
    await onSend(power, body);
    setDraft('');
  }
  return <section className="challenge-chat" aria-label="Messages to other powers">
    <h2>Talk to the other powers</h2>
    <p className="muted">Private, one power at a time. They reply, remember what was said when they choose orders, and may not keep their word. {left} of {chat.limit} messages left.</p>
    <div className="chat-powers" role="tablist">{opponents.map(p => {
      const count = chat.messages.filter(m => m.power === p).length;
      return <button key={p} role="tab" aria-selected={p === power} className={p === power ? 'selected' : ''} onClick={() => setPower(p)}>{name(p)}{count ? ` · ${count}` : ''}</button>;
    })}</div>
    <div className="chat-thread" aria-live="polite">
      {thread.length === 0 && <p className="muted">No messages with {name(power)} yet.</p>}
      {thread.map(m => <div key={m.id} className={m.from === 'PLAYER' ? 'chat-mine' : 'chat-theirs'}>
        <strong>{m.from === 'PLAYER' ? 'You' : name(power)}</strong>
        <p>{m.body}</p>
        {m.reply === 'PENDING' && <small>{name(power)} is replying…</small>}
        {m.reply === 'FAILED' && <small className="chat-failed">No reply arrived. This message still counts; you can write again.</small>}
      </div>)}
      <div ref={end} />
    </div>
    {chat.canSend
      ? <form onSubmit={event => { event.preventDefault(); void send(); }}>
          <textarea aria-label={`Message to ${name(power)}`} value={draft} maxLength={chat.maxLength} rows={3} disabled={busy || waiting || left <= 0}
            placeholder={left <= 0 ? 'You have used every message for this attempt.' : `Write to ${name(power)}…`} onChange={event => setDraft(event.target.value)} />
          <button className="primary" type="submit" disabled={busy || waiting || left <= 0 || !draft.trim()}>{busy || waiting ? 'Waiting for the reply…' : `Send to ${name(power)}`}</button>
        </form>
      : <p className="muted">You can send messages while you are choosing your orders.</p>}
  </section>;
}
