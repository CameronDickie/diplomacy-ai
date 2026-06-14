import { useEffect, useMemo, useRef, useState } from 'react';
import type { Power } from '@diplomacy/shared';
import type { useGameSocket } from '../hooks/useGameSocket.js';
import { POWER_COLORS } from '../lib/game.js';

type GameSocket = ReturnType<typeof useGameSocket>;

export function ChatPanel({ game }: { game: GameSocket }) {
  const [recipient, setRecipient] = useState<Power | null>(null);
  const [draft, setDraft] = useState('');
  const messageListRef = useRef<HTMLDivElement>(null);
  const recipients = useMemo(
    () => game.gameState?.players.filter(player => player.power !== game.myPower) ?? [],
    [game.gameState?.players, game.myPower]
  );
  const messages = useMemo(
    () => recipient
      ? game.diplomaticMessages.filter(message =>
          (message.fromPower === game.myPower && message.toPower === recipient) ||
          (message.fromPower === recipient && message.toPower === game.myPower)
        )
      : [],
    [game.diplomaticMessages, game.myPower, recipient]
  );
  const selectedPlayer = recipients.find(player => player.power === recipient);
  const isWaitingForLlm =
    selectedPlayer?.kind === 'LLM' &&
    recipient !== null &&
    ['THINKING', 'RETRYING'].includes(game.llmStatuses[recipient] ?? '');

  useEffect(() => {
    if (!recipient || !recipients.some(player => player.power === recipient)) {
      setRecipient(recipients[0]?.power ?? null);
    }
  }, [recipient, recipients]);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages.length, recipient]);

  function sendMessage() {
    if (!recipient || !draft.trim()) return;
    game.sendDiplomaticMessage(recipient, draft);
    setDraft('');
  }

  return (
    <section className="chat-panel">
      <div className="chat-sidebar">
        <h2>Diplomacy</h2>
        {recipients.length === 0 && <p className="chat-empty">Join a game to begin diplomacy.</p>}
        {recipients.map(player => {
          const latest = [...game.diplomaticMessages].reverse().find(message =>
            (message.fromPower === game.myPower && message.toPower === player.power) ||
            (message.fromPower === player.power && message.toPower === game.myPower)
          );
          return (
            <button
              className={`conversation-button ${recipient === player.power ? 'selected' : ''}`}
              key={player.id}
              onClick={() => setRecipient(player.power)}
            >
              <span style={{ color: POWER_COLORS[player.power] }}>{player.power}</span>
              <strong>{player.name}</strong>
              <em>{latest?.body ?? (player.kind === 'LLM' ? 'LLM memory ready' : 'No messages yet')}</em>
            </button>
          );
        })}
      </div>

      <div className="conversation">
        <header>
          <div>
            <h2>{recipient ?? 'Select a power'}</h2>
            {recipient && (
              <p>
                Private channel with {recipients.find(player => player.power === recipient)?.name}
              </p>
            )}
          </div>
          <span>{messages.length} messages</span>
        </header>

        <div className="message-list" ref={messageListRef}>
          {recipient && messages.length === 0 && (
            <p className="chat-empty">No messages in this channel.</p>
          )}
          {messages.map(message => {
            const outgoing = message.fromPower === game.myPower;
            return (
              <article className={`chat-message ${outgoing ? 'outgoing' : 'incoming'}`} key={message.id}>
                <div>
                  <strong>{message.fromPower}</strong>
                  <span>
                    {message.year} {message.season}
                    {message.automated ? ' · automated' : ''}
                  </span>
                </div>
                <p>{message.body}</p>
              </article>
            );
          })}
          {isWaitingForLlm && recipient && (
            <article className="chat-message incoming typing-message" aria-live="polite">
              <div>
                <strong>{recipient}</strong>
                <span>thinking</span>
              </div>
              <p><span className="typing-dot">.</span><span className="typing-dot">.</span><span className="typing-dot">.</span></p>
            </article>
          )}
        </div>

        <div className="message-composer">
          <textarea
            aria-label="Diplomatic message"
            maxLength={2000}
            placeholder={recipient ? `Message ${recipient}` : 'Select a recipient'}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            disabled={!recipient || !game.gameId}
          />
          <button
            className="primary"
            onClick={sendMessage}
            disabled={!recipient || !draft.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}
