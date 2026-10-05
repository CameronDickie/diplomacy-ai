import type { useGameSocket } from '../hooks/useGameSocket.js';

type GameSocket = ReturnType<typeof useGameSocket>;

export function DiscordPanel({ game }: { game: GameSocket }) {
  if (!game.gameState || !game.capabilities.discord) return null;
  const isHost = game.gameState.hostPlayerId === game.myPlayerId;
  const status = game.discordStatus;

  return (
    <section className="card discord-card">
      <div className="card-heading">
        <h2>Discord</h2>
        <button type="button" onClick={game.refreshDiscordStatus}>Refresh</button>
      </div>
      {!status.configured ? (
        <p className="field-help">Discord is not configured on this server.</p>
      ) : (
        <>
          <div className="stat-row">
            <span>Server binding</span>
            <strong>{status.guildBound ? 'bound' : 'not bound'}</strong>
          </div>
          <div className="stat-row">
            <span>Your account</span>
            <strong>{status.linked ? status.discordDisplayName : 'not linked'}</strong>
          </div>

          {isHost && !status.guildBound && (
            <button type="button" onClick={game.createDiscordGuildBindCode}>
              Create server bind code
            </button>
          )}
          {!status.guildBound && game.discordGuildBindCode && (
            <CodeBlock
              label="Run /game bind with"
              code={game.discordGuildBindCode.code}
              expiresAt={game.discordGuildBindCode.expiresAt}
            />
          )}

          {status.guildBound && !status.linked && (
            <button type="button" onClick={game.createDiscordPlayerLinkCode}>
              Create player link code
            </button>
          )}
          {!status.linked && game.discordPlayerLinkCode && (
            <CodeBlock
              label="Run /link with"
              code={game.discordPlayerLinkCode.code}
              expiresAt={game.discordPlayerLinkCode.expiresAt}
            />
          )}
        </>
      )}
    </section>
  );
}

function CodeBlock({
  label,
  code,
  expiresAt,
}: {
  label: string;
  code: string;
  expiresAt: string;
}) {
  return (
    <div className="discord-code">
      <span>{label}</span>
      <strong>{code}</strong>
      <em>Expires {new Date(expiresAt).toLocaleTimeString()}</em>
    </div>
  );
}
