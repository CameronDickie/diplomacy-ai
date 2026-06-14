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
} from '@diplomacy/shared';
import { TERRITORIES } from '@diplomacy/shared';
import {
  adjacentTerritories,
  TERRITORY_BY_ID,
  territoryLabel,
  unitLabel,
} from '../lib/game.js';

interface Props {
  gameState: GameState | null;
  myPower: Power | null;
  selectedUnit: Unit | null;
  pendingOrders: Order[];
  onSelectTerritory: (territory: TerritoryId) => void;
  onPendingOrdersChange: (orders: Order[]) => void;
  onSubmitOrders: () => void;
  onSubmitRetreats: (retreats: Record<string, RetreatDestination | null>) => void;
  onSubmitBuilds: (payload: Omit<SubmitBuildsPayload, 'gameId'>) => void;
}

export function OrderPanel(props: Props) {
  const {
    gameState,
    myPower,
    selectedUnit,
    pendingOrders,
    onSelectTerritory,
    onPendingOrdersChange,
    onSubmitOrders,
  } = props;
  const [orderType, setOrderType] = useState<OrderType>('HOLD');
  const [target, setTarget] = useState<TerritoryId>('');
  const [targetCoast, setTargetCoast] = useState<Coast | ''>('');
  const [supportedUnit, setSupportedUnit] = useState<TerritoryId>('');
  const [supportedDestination, setSupportedDestination] = useState<TerritoryId>('');
  const [viaConvoy, setViaConvoy] = useState(false);

  useEffect(() => {
    setOrderType('HOLD');
    setTarget('');
    setTargetCoast('');
    setSupportedUnit('');
    setSupportedDestination('');
    setViaConvoy(false);
  }, [selectedUnit?.id]);

  const supportHoldUnits = useMemo(() => {
    if (!gameState || !selectedUnit) return [];
    const reachable = new Set(adjacentTerritories(selectedUnit));
    return gameState.units.filter(
      unit => !unit.mustRetreat && reachable.has(unit.territory) && unit.id !== selectedUnit.id
    );
  }, [gameState, selectedUnit]);
  const supportMoveUnits = useMemo(
    () => gameState?.units.filter(
      unit => !unit.mustRetreat && unit.id !== selectedUnit?.id
    ) ?? [],
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
    return <section className="card"><h2>Orders</h2><p>Create or join a game to issue orders.</p></section>;
  }

  const myUnits = gameState.units.filter(unit => unit.power === myPower && !unit.mustRetreat);
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
    !gameState.submittedPowers.includes(myPower);

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
    <section className="card order-card">
      <h2>{myPower} Orders</h2>
      <div className="unit-list">
        {myUnits.map(unit => (
          <button
            className={selectedUnit?.id === unit.id ? 'unit-button selected' : 'unit-button'}
            key={unit.id}
            onClick={() => onSelectTerritory(unit.territory)}
          >
            {unitLabel(unit)}
          </button>
        ))}
      </div>

      {gameState.phase === 'ORDERS' && selectedUnit && selectedUnit.power === myPower && (
        <div className="order-builder">
          <h3>{unitLabel(selectedUnit)}</h3>
          <select value={orderType} onChange={event => setOrderType(event.target.value as OrderType)}>
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
              }}>
                <option value="">Target territory</option>
                {moveDestinations.map(destination => (
                  <option value={destination} key={destination}>{territoryLabel(destination)}</option>
                ))}
              </select>
              {targetCoasts.length > 0 && (
                <select value={targetCoast} onChange={event => setTargetCoast(event.target.value as Coast)}>
                  <option value="">Target coast</option>
                  {targetCoasts.map(coast => <option value={coast} key={coast}>{coast}</option>)}
                </select>
              )}
              {selectedUnit.type === 'ARMY' && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={viaConvoy}
                    onChange={event => setViaConvoy(event.target.checked)}
                  />
                  Move via convoy
                </label>
              )}
            </>
          )}

          {(orderType === 'SUPPORT_HOLD' || orderType === 'SUPPORT_MOVE') && (
            <select value={supportedUnit} onChange={event => {
              setSupportedUnit(event.target.value);
              setSupportedDestination('');
            }}>
              <option value="">Unit to support</option>
              {(orderType === 'SUPPORT_HOLD' ? supportHoldUnits : supportMoveUnits).map(unit => (
                <option value={unit.territory} key={unit.id}>{unitLabel(unit)}</option>
              ))}
            </select>
          )}

          {orderType === 'SUPPORT_MOVE' && (
            <select value={supportedDestination} onChange={event => setSupportedDestination(event.target.value)}>
              <option value="">Supported destination</option>
              {supportMoveDestinations.map(destination => (
                <option value={destination} key={destination}>{territoryLabel(destination)}</option>
              ))}
            </select>
          )}

          {orderType === 'CONVOY' && (
            <>
              <select value={supportedUnit} onChange={event => setSupportedUnit(event.target.value)}>
                <option value="">Army to convoy</option>
                {convoyArmies.map(unit => (
                  <option value={unit.territory} key={unit.id}>{unitLabel(unit)}</option>
                ))}
              </select>
              <select value={supportedDestination} onChange={event => setSupportedDestination(event.target.value)}>
                <option value="">Convoy destination</option>
                {convoyDestinations.map(territory => (
                  <option value={territory.id} key={territory.id}>{territoryLabel(territory.id)}</option>
                ))}
              </select>
            </>
          )}

          <button onClick={addOrder} disabled={!canAddOrder()}>Set Order</button>
        </div>
      )}

      {gameState.phase === 'RETREATS' && <RetreatPanel {...props} />}
      {gameState.phase === 'BUILDS' && <BuildPanel {...props} />}

      <div className="pending-list">
        <h3>Pending</h3>
        {pendingOrders.map(order => (
          <p key={order.id}>
            {describeOrder(order)}
            <button
              className="inline-remove"
              aria-label={`Remove order for ${order.unitTerritory}`}
              onClick={() => onPendingOrdersChange(
                pendingOrders.filter(candidate => candidate.id !== order.id)
              )}
            >
              Remove
            </button>
          </p>
        ))}
        <button className="primary" onClick={onSubmitOrders} disabled={!canSubmitOrders}>
          Submit Orders
        </button>
      </div>
    </section>
  );
}

function RetreatPanel({ gameState, myPower, onSubmitRetreats }: Props) {
  const retreats = gameState!.units.filter(unit => unit.power === myPower && unit.mustRetreat);
  const [choices, setChoices] = useState<Record<string, RetreatDestination | null>>({});
  if (retreats.length === 0) return <p>No retreats required.</p>;
  return (
    <div className="order-builder">
      <h3>Retreats</h3>
      {retreats.map(unit => (
        <label key={unit.id}>
          {unitLabel(unit)}
          <select
            value={serializeRetreat(choices[unit.id])}
            onChange={event => setChoices({
              ...choices,
              [unit.id]: parseRetreat(event.target.value),
            })}
          >
            <option value="">Disband</option>
            {unit.retreatOptions.flatMap(option => {
              const coasts = unit.retreatCoasts[option] ?? [];
              if (coasts.length === 0) {
                return <option value={option} key={option}>{territoryLabel(option)}</option>;
              }
              return coasts.map(coast => (
                <option value={`${option}|${coast}`} key={`${option}-${coast}`}>
                  {territoryLabel(option)} / {coast}
                </option>
              ));
            })}
          </select>
        </label>
      ))}
      <button
        className="primary"
        onClick={() => onSubmitRetreats(Object.fromEntries(
          retreats.map(unit => [unit.id, choices[unit.id] ?? null])
        ))}
      >
        Submit Retreats
      </button>
    </div>
  );
}

function serializeRetreat(destination: RetreatDestination | null | undefined): string {
  if (!destination) return '';
  return destination.coast
    ? `${destination.territory}|${destination.coast}`
    : destination.territory;
}

function parseRetreat(value: string): RetreatDestination | null {
  if (!value) return null;
  const [territory, coast] = value.split('|');
  return {
    territory,
    coast: coast ? coast as Coast : null,
  };
}

function BuildPanel({ gameState, myPower, onSubmitBuilds }: Props) {
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
    delta > builds.length &&
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
    <div className="order-builder">
      <h3>Adjustments</h3>
      <p>
        {delta > 0
          ? `${delta} builds available; builds may be waived`
          : `${Math.abs(delta)} disbands required`}
      </p>

      {delta > 0 && (
        <>
          <select value={territory} onChange={event => {
            setTerritory(event.target.value);
            setCoast('');
          }}>
            <option value="">Home supply center</option>
            {availableCenters.map(center => (
              <option value={center.id} key={center.id}>{territoryLabel(center.id)}</option>
            ))}
          </select>
          <select value={unitType} onChange={event => {
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
          <button onClick={addBuild} disabled={!canAddBuild}>Add Build</button>
          {builds.map((build, index) => (
            <p key={`${build.territory}-${build.type}`}>
              {build.type} in {build.territory}{build.coast ? `/${build.coast}` : ''}
              <button
                className="inline-remove"
                onClick={() => setBuilds(current => current.filter((_, item) => item !== index))}
              >
                Remove
              </button>
            </p>
          ))}
        </>
      )}

      {delta < 0 && units.map(unit => (
        <label className="check-row" key={unit.id}>
          <input
            type="checkbox"
            checked={disbands.includes(unit.id)}
            onChange={() => toggleDisband(unit.id)}
          />
          {unitLabel(unit)}
        </label>
      ))}

      <button
        className="primary"
        disabled={delta < 0 && disbands.length !== Math.abs(delta)}
        onClick={() => onSubmitBuilds({ builds, disbands })}
      >
        Submit Adjustments
      </button>
    </div>
  );
}

function describeOrder(order: Order): string {
  if (order.type === 'HOLD') return `${order.unitTerritory} holds`;
  if (order.type === 'MOVE') {
    return `${order.unitTerritory} moves to ${order.targetTerritory}${
      order.targetCoast ? `/${order.targetCoast}` : ''
    }${order.viaConvoy ? ' via convoy' : ''}`;
  }
  if (order.type === 'SUPPORT_HOLD') {
    return `${order.unitTerritory} supports ${order.supportedUnit} holding`;
  }
  if (order.type === 'SUPPORT_MOVE') {
    return `${order.unitTerritory} supports ${order.supportedUnit} to ${order.supportedDestination}`;
  }
  return `${order.unitTerritory} convoys ${order.supportedUnit} to ${order.targetTerritory}`;
}
