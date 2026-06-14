import assert from 'node:assert/strict';
import test from 'node:test';
import { ADJACENCY, TERRITORIES, type TerritoryId } from '@diplomacy/shared';

const territoryIds = new Set<TerritoryId>(TERRITORIES.map(territory => territory.id));
const territoryById = new Map(TERRITORIES.map(territory => [territory.id, territory]));

function fleetNeighbors(territory: TerritoryId): TerritoryId[] {
  const fleet = ADJACENCY[territory].fleet;
  return Array.isArray(fleet) ? fleet : [...new Set(Object.values(fleet).flat())];
}

test('Budapest and Rumania are adjacent for armies but not fleets', () => {
  assert.ok(ADJACENCY.BUD.army.includes('RUM'));
  assert.ok(ADJACENCY.RUM.army.includes('BUD'));
  assert.equal(fleetNeighbors('BUD').includes('RUM'), false);
  assert.equal(fleetNeighbors('RUM').includes('BUD'), false);
});

test('generated adjacency references known territories and is reciprocal', () => {
  for (const territory of TERRITORIES) {
    for (const neighbor of ADJACENCY[territory.id].army) {
      assert.ok(territoryIds.has(neighbor), `${territory.id} army references ${neighbor}`);
      assert.ok(
        ADJACENCY[neighbor].army.includes(territory.id),
        `${territory.id}-${neighbor} army adjacency is not reciprocal`
      );
    }

    for (const neighbor of fleetNeighbors(territory.id)) {
      assert.ok(territoryIds.has(neighbor), `${territory.id} fleet references ${neighbor}`);
      assert.ok(
        fleetNeighbors(neighbor).includes(territory.id),
        `${territory.id}-${neighbor} fleet adjacency is not reciprocal`
      );
    }
  }
});

test('army and fleet adjacency obey province terrain rules', () => {
  for (const territory of TERRITORIES) {
    if (territory.type === 'SEA') {
      assert.deepEqual(ADJACENCY[territory.id].army, [], `${territory.id} permits an army`);
    }
    for (const neighbor of ADJACENCY[territory.id].army) {
      assert.notEqual(territoryById.get(neighbor)?.type, 'SEA', `${territory.id} army enters ${neighbor}`);
    }
    for (const neighbor of fleetNeighbors(territory.id)) {
      assert.notEqual(territoryById.get(neighbor)?.type, 'LAND', `${territory.id} fleet enters ${neighbor}`);
    }
  }
});
