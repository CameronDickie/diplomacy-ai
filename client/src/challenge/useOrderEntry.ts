import { useEffect, useMemo, useState } from 'react';
import { ADJACENCY, TERRITORIES, type ChallengeAction, type ChallengeAttemptView, type ChallengeCard, type ChallengeLegalCatalog, type Unit } from '@diplomacy/shared';
import { adjacentTerritories, territoryName } from '../lib/game.js';

const name = (t: string) => territoryName(t.split('/')[0] as Parameters<typeof territoryName>[0]);

/**
 * Everything about choosing this turn's orders: what each unit may do, what has been chosen, what is
 * inconsistent, and the action to submit. Choices reset whenever the attempt or its phase changes.
 */
export function useOrderEntry(attempt: ChallengeAttemptView | null, card: ChallengeCard | undefined, legal: ChallengeLegalCatalog | null, busy: boolean, playerId: string | undefined) {
  const [selected, setSelected] = useState<string | null>(null), [choices, setChoices] = useState<Record<string, string>>({});
  const [destination, setDestination] = useState<string | null>(null), [focus, setFocus] = useState<string | null>(null);
  useEffect(() => { setDestination(null); setFocus(null); }, [selected, attempt?.id, attempt?.phaseId, playerId]);
  const [retreats, setRetreats] = useState<Record<string, string>>({}), [builds, setBuilds] = useState<Record<string, string>>({}), [disbands, setDisbands] = useState<string[]>([]);
  useEffect(() => { setChoices({}); setRetreats({}); setBuilds({}); setDisbands([]); setSelected(null); }, [attempt?.id, attempt?.phaseId, playerId]);
  const board = attempt?.board ?? card?.board;
  const own = board?.units.filter(u => u.power === card?.humanPower) ?? [];
  const selectedUnit = own.find(u => u.territory === selected && !u.mustRetreat) ?? null;
  const editable = Boolean(attempt && attempt.lifecycle === 'ACTIVE' && attempt.execution === 'ACCEPTING' && !busy);
  // The rules engine lists a move to a place only a convoy can reach twice, as a plain move and as "via convoy".
  // They are the same order; showing both made convoys look inconsistent, so only the explicit one is offered.
  const options = useMemo(() => {
    const all = legal?.options ?? [], explicit = new Set(all.filter(o => o.id.split('|')[1] === 'MOVE_VIA_CONVOY').map(o => `${o.unitTerritory}>${o.id.split('|')[2]}`));
    return all.filter(o => { const [, type, target] = o.id.split('|'), unit = board?.units.find(u => u.territory === o.unitTerritory && u.power === card?.humanPower);
      return !(type === 'MOVE' && explicit.has(`${o.unitTerritory}>${target}`) && unit && !adjacentTerritories(unit).includes(target.split('/')[0] as never)); });
  }, [legal, board, card?.humanPower]);
  const defaultOrder = (u: Unit) => options.find(o => o.unitTerritory === u.territory && o.order.type === 'HOLD')?.id ?? '';
  const active = own.filter(u => !u.mustRetreat);
  const chosenOrders = active.map(u => options.find(o => o.id === (choices[u.id] ?? defaultOrder(u)))?.order).filter(o => o !== undefined);
  const buildDelta = board && card ? TERRITORIES.filter(t => t.isSupplyCenter && board.territoryOwners[t.id] === card.humanPower).length - own.length : 0;
  const homes = TERRITORIES.filter(t => t.homePower === card?.humanPower && board?.territoryOwners[t.id] === card?.humanPower && !board?.units.some(u => u.territory === t.id));
  // A convoy needs a fleet at sea beside the army; until then the rules engine offers none, which is easy to mistake for a fault.
  const convoyHint = Boolean(board?.phase === 'ORDERS' && legal && own.some(u => u.type === 'ARMY') && own.some(u => u.type === 'FLEET') && !options.some(o => o.order.type === 'CONVOY'));
  // An army only crosses by convoy if a fleet is ordered to carry it. When exactly one of the player's fleets can do it
  // alone, choosing the army's convoy move sets that fleet's order too; otherwise the warning below asks.
  function choose(u: Unit, id: string) {
    setDestination(null);
    setChoices(v => {
      const next = { ...v, [u.id]: id }, [, type, target] = id.split('|');
      if (type === 'MOVE_VIA_CONVOY') {
        const carriers = options.filter(o => o.id.split('|')[1] === 'CONVOY' && o.id.split('|')[2] === u.territory && o.id.split('|')[3] === target);
        const touches = (sea: string, land: string) => { const f = ADJACENCY[sea as keyof typeof ADJACENCY]?.fleet; return (Array.isArray(f) ? f : Object.values(f ?? {}).flat()).includes(land.split('/')[0] as never); };
        const all = [...new Set(carriers.map(o => o.unitTerritory))], direct = all.filter(sea => touches(sea, u.territory) && touches(sea, target));
        const pick = direct.length === 1 ? direct[0] : all.length === 1 ? all[0] : null, fleet = pick ? own.find(x => x.territory === pick) : undefined;
        if (fleet) next[fleet.id] = carriers.find(o => o.unitTerritory === pick)!.id;
      }
      return next;
    });
  }
  const movesTo = (territory: string) => options.filter(o => o.unitTerritory === selectedUnit?.territory && o.order.type === 'MOVE' && o.order.targetTerritory === territory);
  const coastChoices = destination ? movesTo(destination) : [];
  // Where the selected unit can move, by any route: the places the map highlights.
  const moveTargets = selectedUnit && board?.phase === 'ORDERS' ? [...new Set(options.filter(o => o.unitTerritory === selectedUnit.territory && o.order.type === 'MOVE').map(o => o.order.targetTerritory!))] : [];
  function moveTo(territory: string) {
    if (!selectedUnit || board?.phase !== 'ORDERS') return false;
    const moves = movesTo(territory);
    if (!moves.length) return false;
    if (new Set(moves.map(o => o.order.targetCoast)).size > 1) setDestination(territory);
    else { choose(selectedUnit, (moves.find(o => !o.order.viaConvoy) ?? moves[0]).id); setSelected(null); }
    return true;
  }
  // The selected unit's orders that involve a place, other than its own: supporting or convoying the unit
  // there, or into there. Tapping such a place narrows the unit's menu to them.
  const involving = (territory: string) => options.filter(o => o.unitTerritory === selectedUnit?.territory && o.id.split('|').slice(2).some(part => part.split('/')[0] === territory));
  /**
   * A tap on the map while giving orders: a highlighted place orders the selected unit there, one of your
   * units selects it (or lets it go), and any other place narrows the selected unit's menu to the orders
   * that involve it. False when the tap means nothing for the orders.
   */
  function place(territory: string) {
    if (board?.phase !== 'ORDERS') return false;
    if (moveTo(territory)) return true;
    if (active.some(u => u.territory === territory)) { setSelected(now => now === territory ? null : territory); return true; }
    if (selectedUnit && involving(territory).length) { setFocus(territory); return true; }
    return false;
  }
  const chosenIds = active.map(u => choices[u.id] ?? defaultOrder(u)).filter(Boolean).map(id => id.split('|'));
  const convoyWarnings = board?.phase === 'ORDERS' ? [
    ...chosenIds.filter(([unit, type, target]) => type === 'MOVE_VIA_CONVOY' && !chosenIds.some(([, t, army, to]) => t === 'CONVOY' && army === unit && to === target))
      .map(([unit, , target]) => `${name(unit)} is ordered to ${name(target)} by convoy, but none of your fleets is ordered to convoy it there. An allied fleet may provide the convoy, but an ally's promise does not submit their order. They must order a matching convoy route, and it must survive, or the move will fail.`),
    ...chosenIds.filter(([, type, army, to]) => type === 'CONVOY' && own.some(u => u.territory === army) && !chosenIds.some(([unit, t, target]) => unit === army && t === 'MOVE_VIA_CONVOY' && target === to))
      .map(([fleet, , army, to]) => `${name(fleet)} is ordered to convoy ${name(army)} to ${name(to)}, but that army is not ordered to move there by convoy.`),
  ] : [];
  // Some phases ask nothing of the player. The server normally plays those itself; this covers the case where it could not.
  const nothingToDo = Boolean(board && (board.phase === 'ORDERS' ? active.length === 0 : board.phase === 'RETREATS' ? !own.some(u => u.mustRetreat) : buildDelta === 0));
  function submission(): ChallengeAction | null {
    if (!attempt) return null;
    if (attempt.board.phase === 'ORDERS') return { phase: 'ORDERS', orderIds: chosenOrders.map(o => o.id) };
    if (attempt.board.phase === 'RETREATS') return { phase: 'RETREATS', retreats: Object.fromEntries(own.filter(u => u.mustRetreat).map(u => { const raw = retreats[u.id]; const [territory, coast] = raw?.split('/') ?? []; return [u.id, territory ? { territory, coast: coast || null } : null]; })) } as ChallengeAction;
    return { phase: 'BUILDS', builds: Object.entries(builds).filter(([, v]) => !!v).map(([territory, v]) => { const [type, coast] = v.split('/'); return { territory, type, coast: coast || null }; }), disbands } as ChallengeAction;
  }
  const complete = attempt?.board.phase !== 'ORDERS' || (!!legal && chosenOrders.length === active.length);
  return { board, own, active, selected, setSelected, selectedUnit, editable, options, defaultOrder, choices, choose, chosenOrders, retreats, setRetreats, builds, setBuilds, disbands, setDisbands,
    buildDelta, homes, convoyHint, convoyWarnings, nothingToDo, submission, complete, coastChoices, moveTo, moveTargets, place, focus, setFocus, involving };
}
export type OrderEntry = ReturnType<typeof useOrderEntry>;
