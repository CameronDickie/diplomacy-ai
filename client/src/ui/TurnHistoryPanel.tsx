import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AdjustmentResolution,
  GameState,
  Order,
  PublicPhaseReport,
  RetreatResolution,
} from '@diplomacy/shared';
import { territoryName } from '../lib/game.js';

export function TurnHistoryPanel({
  reports,
  onReplay,
  gameState,
}: {
  reports: PublicPhaseReport[];
  onReplay: (report: PublicPhaseReport) => void;
  gameState: GameState;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    reports.find(report => report.id === selectedId) ??
    reports[reports.length - 1] ??
    null;

  useEffect(() => {
    if (reports.length > 0 && !reports.some(report => report.id === selectedId)) {
      setSelectedId(reports[reports.length - 1].id);
    }
  }, [reports, selectedId]);

  return (
    <section className="card turn-history">
      <div className="card-heading">
        <h2>Turn History</h2>
        <button
          type="button"
          onClick={() => exportPublicArchive(gameState, reports)}
          disabled={reports.length === 0}
        >
          Export JSON
        </button>
      </div>
      {reports.length === 0 ? (
        <p className="history-empty">Resolved phases will appear here.</p>
      ) : (
        <>
          <div className="history-timeline" aria-label="Resolved phase timeline">
            {[...reports].reverse().map(report => (
              <button
                className={report.id === selected?.id ? 'selected' : ''}
                key={report.id}
                onClick={() => setSelectedId(report.id)}
              >
                <strong>{report.year} {report.season}</strong>
                <span>{phaseLabel(report)}</span>
              </button>
            ))}
          </div>
          {selected && <PhaseReport report={selected} onReplay={onReplay} />}
        </>
      )}
    </section>
  );
}

function PhaseReport({
  report,
  onReplay,
}: {
  report: PublicPhaseReport;
  onReplay: (report: PublicPhaseReport) => void;
}) {
  return (
    <div className="phase-report">
      <header>
        <h3>{report.year} {report.season} {phaseLabel(report)}</h3>
        <div>
          <time dateTime={report.resolvedAt}>
            {new Date(report.resolvedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <button type="button" onClick={() => onReplay(report)}>Replay</button>
        </div>
      </header>

      {report.phase === 'ORDERS' && (
        <>
          <ReportSection title="Orders">
            {report.resolvedOrders.map(order => (
              <p className={`report-result result-${order.resolution.toLowerCase()}`} key={order.id}>
                <strong>{order.power}</strong>
                <span>{describeOrder(order)}</span>
                <em>{resolutionLabel(order.resolution)}: {humanizeReason(order.reason)}</em>
              </p>
            ))}
          </ReportSection>
          {report.standoffTerritories.length > 0 && (
            <ReportSection title="Standoffs">
              <p>{report.standoffTerritories.map(territoryName).join(', ')}</p>
            </ReportSection>
          )}
          {report.dislodgedUnits.length > 0 && (
            <ReportSection title="Dislodged">
              {report.dislodgedUnits.map(unit => (
                <p key={unit.id}>{unit.power} {unit.type.toLowerCase()} in {territoryName(unit.territory)}</p>
              ))}
            </ReportSection>
          )}
          {report.destroyedUnits.length > 0 && (
            <ReportSection title="Destroyed">
              {report.destroyedUnits.map(unit => (
                <p key={unit.id}>{unit.power} {unit.type.toLowerCase()} in {territoryName(unit.territory)}</p>
              ))}
            </ReportSection>
          )}
          {report.ownershipChanges.length > 0 && (
            <ReportSection title="Supply Control">
              {report.ownershipChanges.map(change => (
                <p key={change.territory}>
                  {territoryName(change.territory)}: {change.fromPower ?? 'Neutral'} to {change.toPower ?? 'Neutral'}
                </p>
              ))}
            </ReportSection>
          )}
        </>
      )}

      {report.phase === 'RETREATS' && (
        <ReportSection title="Retreats">
          {report.retreats.map(retreat => (
            <p key={retreat.unitId}>{describeRetreat(retreat)}</p>
          ))}
        </ReportSection>
      )}

      {report.phase === 'BUILDS' && (
        <ReportSection title="Adjustments">
          {report.adjustments.map(adjustment => (
            <AdjustmentReport adjustment={adjustment} key={adjustment.power} />
          ))}
        </ReportSection>
      )}
    </div>
  );
}

function ReportSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function AdjustmentReport({ adjustment }: { adjustment: AdjustmentResolution }) {
  return (
    <div className="adjustment-report">
      <strong>{adjustment.power}</strong>
      {adjustment.builds.map(build => (
        <p key={`${build.territory}-${build.type}`}>
          Built {build.type.toLowerCase()} in {territoryName(build.territory)}
          {build.coast ? ` (${build.coast.toLowerCase()} coast)` : ''}
        </p>
      ))}
      {adjustment.disbandedUnits.map(unit => (
        <p key={unit.id}>Disbanded {unit.type.toLowerCase()} in {territoryName(unit.territory)}</p>
      ))}
      {adjustment.waivedBuilds > 0 && <p>Waived {adjustment.waivedBuilds} build(s)</p>}
    </div>
  );
}

function describeRetreat(retreat: RetreatResolution): string {
  const unit = `${retreat.power} ${retreat.unitType.toLowerCase()} in ${territoryName(retreat.fromTerritory)}`;
  if (retreat.outcome === 'DISBANDED') return `${unit} was disbanded`;
  if (retreat.outcome === 'CONFLICT') {
    return `${unit} attempted to retreat to ${territoryName(retreat.toTerritory!)} and was disbanded by a retreat conflict`;
  }
  return `${unit} retreated to ${territoryName(retreat.toTerritory!)}${
    retreat.toCoast ? ` (${retreat.toCoast.toLowerCase()} coast)` : ''
  }`;
}

function describeOrder(order: Order): string {
  const source = territoryName(order.unitTerritory);
  if (order.type === 'HOLD') return `${source} held`;
  if (order.type === 'MOVE') {
    return `${source} moved to ${territoryName(order.targetTerritory!)}`;
  }
  if (order.type === 'SUPPORT_HOLD') {
    return `${source} supported ${territoryName(order.supportedUnit!)} holding`;
  }
  if (order.type === 'SUPPORT_MOVE') {
    return `${source} supported ${territoryName(order.supportedUnit!)} to ${territoryName(order.supportedDestination!)}`;
  }
  return `${source} convoyed ${territoryName(order.supportedUnit!)} to ${territoryName(order.targetTerritory!)}`;
}

function resolutionLabel(resolution: string): string {
  return {
    SUCCEEDS: 'Succeeded',
    FAILS: 'Failed',
    BOUNCED: 'Bounced',
    DISLODGED: 'Dislodged',
    CUT: 'Support cut',
    VOID: 'Invalid',
  }[resolution] ?? resolution;
}

function humanizeReason(reason: string): string {
  if (reason === 'Order succeeded') return 'order resolved successfully';
  return reason
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[()]/g, '')
    .trim();
}

function phaseLabel(report: PublicPhaseReport): string {
  if (report.phase === 'ORDERS') return 'Orders';
  if (report.phase === 'RETREATS') return 'Retreats';
  return 'Adjustments';
}

function exportPublicArchive(
  gameState: GameState,
  reports: PublicPhaseReport[]
): void {
  const archive = {
    format: 'diplomacy-public-game',
    version: 1,
    exportedAt: new Date().toISOString(),
    game: {
      gameId: gameState.gameId,
      status: gameState.status,
      winner: gameState.winner,
      players: gameState.players.map(player => ({
        name: player.name,
        power: player.power,
        kind: player.kind,
      })),
    },
    reports,
  };
  const blob = new Blob([JSON.stringify(archive, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `diplomacy-${gameState.gameId}-public.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
