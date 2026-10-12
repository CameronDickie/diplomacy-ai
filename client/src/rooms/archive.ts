import type { GameState, PublicPhaseReport } from '@diplomacy/shared';

/** Downloads the public record of a hosted game: the players and every resolved phase. No private messages. */
export function exportPublicArchive(gameState: GameState, reports: PublicPhaseReport[]): void {
  const archive = {
    format: 'diplomacy-public-game',
    version: 1,
    exportedAt: new Date().toISOString(),
    game: {
      gameId: gameState.gameId,
      status: gameState.status,
      winner: gameState.winner,
      players: gameState.players.map(player => ({ name: player.name, power: player.power, kind: player.kind })),
    },
    reports,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `diplomacy-${gameState.gameId}-public.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
