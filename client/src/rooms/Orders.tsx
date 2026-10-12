import { useEffect, useMemo, useState } from 'react';
import type {
  Coast,
  GameState,
  Order,
  OrderType,
  Power,
  RetreatDestination,
  SubmitBuildsPayload,
  TerritoryId,
  Unit,
  UnitType,
  SubmissionState,
} from '@diplomacy/shared';
import { TERRITORIES } from '@diplomacy/shared';
import {
  adjacentTerritories,
  TERRITORY_BY_ID,
  territoryName,
} from '../lib/game.js';
import { ArrowFillButton } from '../challenge/Shell.js';
import { describeOrderFields, title } from '../challenge/text.js';

const territoryLabel = (id: TerritoryId) => territoryName(id);
/** "Army · Paris", with the owner when it is somebody else's unit. */
const unitLabel = (unit: Unit, own?: Power | null) =>
  `${title(unit.type)} · ${territoryName(unit.territory)}${unit.coast ? ` (${unit.coast.toLowerCase()} coast)` : ''}${own && unit.power !== own ? ` · ${title(unit.power)}` : ''}`;

interface Props {
  submission: SubmissionState | null;
  gameState: GameState | null;
  myPower: Power | null;
  selectedUnit: Unit | null;
  pendingOrders: Order[];
  onSelectTerritory: (territory: TerritoryId | null) => void;
  onPendingOrdersChange: (orders: Order[]) => void;
  onSubmitOrders: () => void;
  onSubmitRetreats: (retreats: Record<string, RetreatDestination | null>) => void;
  onSubmitBuilds: (payload: Omit<SubmitBuildsPayload, 'gameId'>) => void;
}

/**
 * This turn's decisions for a hosted game: one order per unit, then retreats or adjustments.
 * Orders can also be given on the map; both feed the same pending list.
 */
export function Orders(props: Props) {
  const {
    gameState,
    myPower,
    selectedUnit,
    pendingOrders,
    onSelectTerritory,
    onPendingOrdersChange,
    onSubmitOrders,
    submission,
  } = props;
  const [orderType, setOrderType] = useState<OrderType>('HOLD');
  const [target, setTarget] = useState<TerritoryId>('');
  const [targetCoast, setTargetCoast] = useState<Coast | ''>('');
  const [supportedUnit, setSupportedUnit] = useState<TerritoryId>('');
  const [supportedDestination, setSupportedDestination] = useState<TerritoryId>('');
  const [viaConvoy, setViaConvoy] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);

  useEffect(() => {
    setOrderType('HOLD');
    setTarget('');
    setTargetCoast('');
    setSupportedUnit('');
    setSupportedDestination('');
    setViaConvoy(false);
    setDraftDirty(false);
  }, [selectedUnit?.id]);

  useEffect(() => {
    if (!selectedUnit) return;
    if (
      pendingOrders.some(order =>
        order.unitTerritory === selectedUnit.territory &&
        order.unitCoast === selectedUnit.coast
      )
    ) {
      setDraftDirty(false);
    }
  }, [pendingOrders, selectedUnit]);

  const supportHoldUnits = useMemo(() => {
    if (!gameState || !selectedUnit) return [];
    const reachable = new Set(adjacentTerritories(selectedUnit));
    return gameState.units.filter(
      unit => !unit.mustRetreat && reachable.has(unit.territory) && unit.id !== selectedUnit.id
    );
  }, [gameState, selectedUnit]);
  const supportMoveUnits = useMemo(
    () => {
      if (!gameState || !selectedUnit) return [];
      const supporterReach = new Set(adjacentTerritories(selectedUnit));
      return gameState.units.filter(unit =>
        !unit.mustRetreat &&
        unit.id !== selectedUnit.id &&
        adjacentTerritories(unit).some(destination => supporterReach.has(destination))
      );
    },
    [gameState, selectedUnit]
  );

  const supportMoveDestinations = useMemo(() => {
    if (!gameState || !selectedUnit || !supportedUnit) return [];
    const unit = gameState.units.find(candidate => candidate.territory === supportedUnit);
    if (!unit) return [];
    const supporterReach = new Set(adjacentTerritories(selectedUnit));
    return adjacentTerritories(unit).filter(destination => supporterReach.has(destination));
  }, [gameState, selectedUnit, supportedUnit]);

  if (!gameState || !myPower) {
    return <p className="dip-muted">Create or join a game to give orders.</p>;
  }

  const myUnits = gameState.units.filter(unit => unit.power === myPower && !unit.mustRetreat);
  const orderedUnitKeys = new Set(
    pendingOrders.map(order => orderKey(order.unitTerritory, order.unitCoast))
  );
  const unorderedUnits = myUnits.filter(
    unit => !orderedUnitKeys.has(orderKey(unit.territory, unit.coast))
  );
  const destinations = selectedUnit ? adjacentTerritories(selectedUnit) : [];
  const moveDestinations =
    viaConvoy && selectedUnit?.type === 'ARMY'
      ? TERRITORIES.filter(territory => territory.type === 'COASTAL').map(territory => territory.id)
      : destinations;
  const targetDefinition = target ? TERRITORY_BY_ID[target] : null;
  const targetCoasts =
    selectedUnit?.type === 'FLEET' && targetDefinition ? targetDefinition.coasts : [];
  const convoyArmies = gameState.units.filter(
    unit =>
      unit.type === 'ARMY' &&
      !unit.mustRetreat &&
      TERRITORY_BY_ID[unit.territory]?.type === 'COASTAL'
  );
  const convoyDestinations = TERRITORIES.filter(territory => territory.type === 'COASTAL');
  const canConvoy =
    selectedUnit?.type === 'FLEET' &&
    TERRITORY_BY_ID[selectedUnit.territory]?.type === 'SEA';
  const canSubmitOrders =
    gameState.status === 'IN_PROGRESS' &&
    gameState.phase === 'ORDERS' &&
    !gameState.submittedPowers.includes(myPower) &&
    !['SUBMITTING', 'ACCEPTED'].includes(submission?.status ?? '');
  const canSubmitCompleteOrders =
    canSubmitOrders &&
    unorderedUnits.length === 0 &&
    !draftDirty;
  const hasSubmittedOrders = submission?.status === 'ACCEPTED';
  const activePowers = new Set(
    gameState.units.filter(unit => !unit.mustRetreat).map(unit => unit.power)
  );
  const waitingHumans = gameState.players.filter(
    player =>
      player.kind === 'HUMAN' &&
      activePowers.has(player.power) &&
      !gameState.submittedPowers.includes(player.power)
  );
  const hasActiveLlm = gameState.players.some(
    player => player.kind === 'LLM' && activePowers.has(player.power)
  );

  function addOrder() {
    if (!selectedUnit || !canAddOrder()) return;
    const nextOrder: Order = {
      id: crypto.randomUUID(),
      power: selectedUnit.power,
      unitTerritory: selectedUnit.territory,
      unitCoast: selectedUnit.coast,
      type: orderType,
      targetTerritory:
        orderType === 'MOVE'
          ? target
          : orderType === 'CONVOY'
            ? supportedDestination
            : null,
      targetCoast: orderType === 'MOVE' ? targetCoast || null : null,
      viaConvoy: orderType === 'MOVE' ? viaConvoy : undefined,
      supportedUnit:
        orderType === 'SUPPORT_HOLD' ||
        orderType === 'SUPPORT_MOVE' ||
        orderType === 'CONVOY'
          ? supportedUnit
          : null,
      supportedDestination:
        orderType === 'SUPPORT_MOVE' ? supportedDestination : null,
    };
    onPendingOrdersChange([
      ...pendingOrders.filter(order => order.unitTerritory !== selectedUnit.territory),
      nextOrder,
    ]);
    setDraftDirty(false);
  }

  function canAddOrder(): boolean {
    if (!selectedUnit) return false;
    if (orderType === 'HOLD') return true;
    if (orderType === 'MOVE') {
      return Boolean(target && (targetCoasts.length === 0 || targetCoast));
    }
    if (orderType === 'SUPPORT_HOLD') return Boolean(supportedUnit);
    if (orderType === 'SUPPORT_MOVE') {
      return Boolean(supportedUnit && supportedDestination);
    }
    return Boolean(canConvoy && supportedUnit && supportedDestination);
  }

  return (
    <div className="dip-orders">
      {submission?.status === 'SUBMITTING' && <p role="status" className="dip-small">Submitting decisions. Waiting for the server…</p>}
      {submission?.status === 'FAILED' && <p role="alert" className="dip-notice is-error">{submission.error?.message ?? 'Submission failed. Please retry.'}</p>}
      {gameState.phase === 'ORDERS' && hasSubmittedOrders && (
        <div className="dip-notice" role="status" style={{ color: 'var(--folio-success)' }}>
          <strong>Orders submitted.</strong>{' '}
          {waitingHumans.length > 0
            ? `Waiting for ${waitingHumans.map(player => player.power).join(', ')}.`
            : hasActiveLlm
              ? 'All human orders are in. Waiting for automated powers to finish.'
              : 'All orders are in. Resolving the turn.'}
        </div>
      )}
      {gameState.phase === 'ORDERS' && <ul className="dip-list" aria-label="Your units">
        {myUnits.map(unit => {
          const order = pendingOrders.find(candidate => orderKey(candidate.unitTerritory, candidate.unitCoast) === orderKey(unit.territory, unit.coast));
          return (
            <li key={unit.id}>
              <span>
                <button
                  className="dip-unit"
                  aria-pressed={selectedUnit?.id === unit.id}
                  onClick={() => onSelectTerritory(selectedUnit?.id === unit.id ? null : unit.territory)}
                >
                  {unitLabel(unit)}
                </button>
                <small style={order ? undefined : { color: 'var(--folio-warning)' }}>{order ? describeOrder(order) : 'Needs an order'}</small>
              </span>
              {order && canSubmitOrders && <button
                className="dip-link dip-small"
                aria-label={`Remove order for ${territoryName(unit.territory)}`}
                onClick={() => onPendingOrdersChange(pendingOrders.filter(candidate => candidate.id !== order.id))}
              >Remove</button>}
            </li>
          );
        })}
      </ul>}

      {canSubmitOrders && selectedUnit && selectedUnit.power === myPower && (
        <div className="dip-builder">
          <h3>{unitLabel(selectedUnit)}</h3>
          <p className="dip-muted dip-small">
            Choose an order here, or click a destination on the map. Nothing is sent until you submit.
          </p>
          <select aria-label="Order type" value={orderType} onChange={event => {
            setOrderType(event.target.value as OrderType);
            setDraftDirty(true);
          }}>
            <option value="HOLD">Hold</option>
            <option value="MOVE">Move</option>
            <option value="SUPPORT_HOLD">Support hold</option>
            <option value="SUPPORT_MOVE">Support move</option>
            {canConvoy && <option value="CONVOY">Convoy</option>}
          </select>

          {orderType === 'MOVE' && (
            <>
              <select value={target} onChange={event => {
                setTarget(event.target.value);
                setTargetCoast('');
                setDraftDirty(true);
              }}>
                <option value="">Target territory</option>
                {moveDestinations.map(destination => (
                  <option value={destination} key={destination}>{territoryLabel(destination)}</option>
                ))}
              </select>
              {targetCoasts.length > 0 && (
                <select value={targetCoast} onChange={event => {
                  setTargetCoast(event.target.value as Coast);
                  setDraftDirty(true);
                }}>
                  <option value="">Target coast</option>
                  {targetCoasts.map(coast => <option value={coast} key={coast}>{coast}</option>)}
                </select>
              )}
              {selectedUnit.type === 'ARMY' && (
                <label className="dip-check">
                  <input
                    type="checkbox"
                    checked={viaConvoy}
                    onChange={event => {
                      setViaConvoy(event.target.checked);
                      setDraftDirty(true);
                    }}
                  />
                  Move via convoy
                </label>
              )}
              {selectedUnit.type === 'FLEET' && (
                <p className="dip-muted dip-small">
                  Fleets can only reach adjacent seas and coastal provinces.
                </p>
              )}
            </>
          )}

          {(orderType === 'SUPPORT_HOLD' || orderType === 'SUPPORT_MOVE') && (
            <select value={supportedUnit} onChange={event => {
              setSupportedUnit(event.target.value);
              setSupportedDestination('');
              setDraftDirty(true);
            }}>
              <option value="">Unit to support</option>
              {(orderType === 'SUPPORT_HOLD' ? supportHoldUnits : supportMoveUnits).map(unit => (
                <option value={unit.territory} key={unit.id}>{unitLabel(unit, myPower)}</option>
              ))}
            </select>
          )}

          {orderType === 'SUPPORT_MOVE' && (
            <select value={supportedDestination} onChange={event => {
              setSupportedDestination(event.target.value);
              setDraftDirty(true);
            }}>
              <option value="">Supported destination</option>
              {supportMoveDestinations.map(destination => (
                <option value={destination} key={destination}>{territoryLabel(destination)}</option>
              ))}
            </select>
          )}

          {orderType === 'CONVOY' && (
            <>
              <select value={supportedUnit} onChange={event => {
                setSupportedUnit(event.target.value);
                setDraftDirty(true);
              }}>
                <option value="">Army to convoy</option>
                {convoyArmies.map(unit => (
                  <option value={unit.territory} key={unit.id}>{unitLabel(unit, myPower)}</option>
                ))}
              </select>
              <select value={supportedDestination} onChange={event => {
                setSupportedDestination(event.target.value);
                setDraftDirty(true);
              }}>
                <option value="">Convoy destination</option>
                {convoyDestinations.map(territory => (
                  <option value={territory.id} key={territory.id}>{territoryLabel(territory.id)}</option>
                ))}
              </select>
            </>
          )}

          <button
            className={draftDirty ? 'dip-solid' : undefined}
            onClick={addOrder}
            disabled={!canAddOrder()}
          >
            Set this order
          </button>
          {draftDirty && (
            <p className="dip-small" role="status" style={{ color: 'var(--folio-warning)' }}>
              This order is not set yet.
            </p>
          )}
        </div>
      )}

      {gameState.phase === 'RETREATS' && <RetreatPanel {...props} />}
      {gameState.phase === 'BUILDS' && <BuildPanel {...props} />}

      {gameState.phase === 'ORDERS' && <>
        {canSubmitOrders && unorderedUnits.length > 0 && (
          <p className="dip-small dip-muted" role="status">
            Still to order: {unorderedUnits.map(unit => territoryName(unit.territory)).join(', ')}.
          </p>
        )}
        <div className="dip-orders-actions">
          <ArrowFillButton
            onClick={onSubmitOrders}
            disabled={!canSubmitCompleteOrders}
            title={
              canSubmitCompleteOrders
                ? undefined
                : draftDirty
                  ? 'Set or discard the order you are editing before submitting.'
                  : unorderedUnits.length > 0
                    ? 'Every unit needs an order before you can submit.'
                    : undefined
            }
          >
            {hasSubmittedOrders ? 'Orders submitted' : submission?.status === 'SUBMITTING' ? 'Submitting…' : 'Submit orders'}
          </ArrowFillButton>
        </div>
      </>}
    </div>
  );
}

function RetreatPanel({ gameState, myPower, onSubmitRetreats, submission }: Props) {
  const retreats = gameState!.units.filter(unit => unit.power === myPower && unit.mustRetreat);
  const [choices, setChoices] = useState<Record<string, RetreatDestination | null>>({});
  const submitted = submission?.status === 'ACCEPTED';
  const submitting = submission?.status === 'SUBMITTING';
  useEffect(() => {
    setChoices(current => {
      const next = { ...current };
      for (const unit of retreats) {
        if (!(unit.id in next)) next[unit.id] = defaultRetreat(unit);
      }
      return next;
    });
  }, [retreats.map(unit => unit.id).join('|')]);
  if (retreats.length === 0) return <p className="dip-muted dip-small" role="status">None of your units has to retreat. Waiting for the powers that do.</p>;
  return (
    <div className="dip-builder">
      {retreats.map(unit => (
        <label key={unit.id}>
          Retreat from {territoryName(unit.territory)}
          <select
            disabled={submitted || submitting}
            value={serializeRetreat(choices[unit.id])}
            onChange={event => setChoices({
              ...choices,
              [unit.id]: parseRetreat(event.target.value),
            })}
          >
            {unit.retreatOptions.flatMap(option => {
              const coasts = unit.retreatCoasts[option] ?? [];
              if (coasts.length === 0) {
                return <option value={option} key={option}>{territoryLabel(option)}</option>;
              }
              return coasts.map(coast => (
                <option value={`${option}|${coast}`} key={`${option}-${coast}`}>
                  {territoryLabel(option)} ({coast.toLowerCase()} coast)
                </option>
              ));
            })}
            <option value="__DISBAND__">Disband</option>
          </select>
        </label>
      ))}
      <div className="dip-orders-actions"><ArrowFillButton
        disabled={submitted || submitting}
        onClick={() => {
          onSubmitRetreats(Object.fromEntries(
            retreats.map(unit => [unit.id, choices[unit.id] ?? null])
          ));
        }}
      >
        {submitted ? 'Retreats submitted' : submitting ? 'Submitting…' : 'Submit retreats'}
      </ArrowFillButton></div>
    </div>
  );
}

function serializeRetreat(destination: RetreatDestination | null | undefined): string {
  if (!destination) return '__DISBAND__';
  return destination.coast
    ? `${destination.territory}|${destination.coast}`
    : destination.territory;
}

function parseRetreat(value: string): RetreatDestination | null {
  if (!value || value === '__DISBAND__') return null;
  const [territory, coast] = value.split('|');
  return {
    territory,
    coast: coast ? coast as Coast : null,
  };
}

function defaultRetreat(unit: Unit): RetreatDestination | null {
  const territory = unit.retreatOptions[0];
  if (!territory) return null;
  return {
    territory,
    coast: unit.retreatCoasts[territory]?.[0] ?? null,
  };
}

function BuildPanel({ gameState, myPower, onSubmitBuilds, submission }: Props) {
  const state = gameState!;
  const power = myPower!;
  const ownedCenters = Object.values(state.territories).filter(
    territory => territory.owner === power && territory.isSupplyCenter
  ).length;
  const units = state.units.filter(unit => unit.power === power);
  const delta = ownedCenters - units.length;
  const [builds, setBuilds] = useState<SubmitBuildsPayload['builds']>([]);
  const [disbands, setDisbands] = useState<string[]>([]);
  const [territory, setTerritory] = useState<TerritoryId>('');
  const [unitType, setUnitType] = useState<UnitType>('ARMY');
  const [coast, setCoast] = useState<Coast | ''>('');
  const submitted = submission?.status === 'ACCEPTED';
  const submitting = submission?.status === 'SUBMITTING';
  const remainingBuilds = Math.max(0, delta - builds.length);
  const requiredDisbands = Math.max(0, -delta);
  const remainingDisbands = Math.max(0, requiredDisbands - disbands.length);

  const availableCenters = TERRITORIES.filter(candidate =>
    candidate.isSupplyCenter &&
    candidate.homePower === power &&
    state.territories[candidate.id]?.owner === power &&
    !state.units.some(unit => unit.territory === candidate.id) &&
    !builds.some(build => build.territory === candidate.id)
  );
  const selectedCenter = territory ? TERRITORY_BY_ID[territory] : null;
  const buildCoasts = unitType === 'FLEET' ? selectedCenter?.coasts ?? [] : [];
  const canAddBuild =
    remainingBuilds > 0 &&
    Boolean(territory) &&
    !(unitType === 'FLEET' && selectedCenter?.type === 'LAND') &&
    (buildCoasts.length === 0 || Boolean(coast));

  function addBuild() {
    if (!canAddBuild) return;
    setBuilds(current => [...current, {
      type: unitType,
      territory,
      coast: unitType === 'FLEET' ? coast || null : null,
    }]);
    setTerritory('');
    setCoast('');
  }

  function toggleDisband(unitId: string) {
    setDisbands(current =>
      current.includes(unitId)
        ? current.filter(id => id !== unitId)
        : current.length < Math.abs(delta)
          ? [...current, unitId]
          : current
    );
  }

  return (
    <fieldset className="dip-builder" disabled={submitted || submitting}>
      <p className="dip-small" aria-live="polite">
        {delta > 0
          ? `${remainingBuilds} of ${delta} builds left to choose. Unused builds are waived.`
          : delta < 0
            ? `${remainingDisbands} of ${requiredDisbands} disbands left to choose.`
            : 'Your units already match your supply centers. Submit to continue.'}
      </p>

      {delta > 0 && remainingBuilds > 0 && (
        <>
          <select aria-label="Home supply center" value={territory} onChange={event => {
            setTerritory(event.target.value);
            setCoast('');
          }}>
            <option value="">Home supply center</option>
            {availableCenters.map(center => (
              <option value={center.id} key={center.id}>{territoryLabel(center.id)}</option>
            ))}
          </select>
          <select aria-label="Unit type" value={unitType} onChange={event => {
            setUnitType(event.target.value as UnitType);
            setCoast('');
          }}>
            <option value="ARMY">Army</option>
            <option value="FLEET">Fleet</option>
          </select>
          {buildCoasts.length > 0 && (
            <select value={coast} onChange={event => setCoast(event.target.value as Coast)}>
              <option value="">Build coast</option>
              {buildCoasts.map(option => <option value={option} key={option}>{option}</option>)}
            </select>
          )}
          <button onClick={addBuild} disabled={!canAddBuild}>Add this build</button>
        </>
      )}

      {delta > 0 && builds.length > 0 && (
        <ul className="dip-list" aria-label="Chosen builds">
          {builds.map((build, index) => (
            <li key={`${build.territory}-${build.type}`}>
              <span>{title(build.type)} in {territoryName(build.territory)}{build.coast ? ` (${build.coast.toLowerCase()} coast)` : ''}</span>
              <button
                className="dip-link dip-small"
                onClick={() => setBuilds(current => current.filter((_, item) => item !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {delta < 0 && remainingDisbands > 0 && units.map(unit => (
        <label className="dip-check" key={unit.id}>
          <input
            type="checkbox"
            checked={disbands.includes(unit.id)}
            onChange={() => toggleDisband(unit.id)}
          />
          {unitLabel(unit)}
        </label>
      ))}

      {delta < 0 && remainingDisbands === 0 && (
        <ul className="dip-list" aria-label="Chosen disbands">
          {units.filter(unit => disbands.includes(unit.id)).map(unit => (
            <li key={unit.id}>
              <span>{unitLabel(unit)}</span>
              <button className="dip-link dip-small" onClick={() => toggleDisband(unit.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="dip-orders-actions"><ArrowFillButton
        disabled={submitted || submitting || (delta < 0 && remainingDisbands !== 0)}
        onClick={() => {
          onSubmitBuilds({ builds, disbands });
        }}
      >
        {submitted
          ? 'Adjustments submitted'
          : submitting ? 'Submitting…'
          : delta > 0 && remainingBuilds > 0
          ? `Submit and waive ${remainingBuilds}`
          : 'Submit adjustments'}
      </ArrowFillButton></div>
    </fieldset>
  );
}

function orderKey(territory: TerritoryId, coast: Coast | null): string {
  return `${territory}:${coast ?? ''}`;
}

const describeOrder = (order: Order) => describeOrderFields(order);
