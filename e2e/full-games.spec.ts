import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ChallengeLegalCatalog, Order, Power } from '@diplomacy/shared';
import type { BoardSnapshot, LiveGame } from '../client/src/viewer/FullGames.js';

const fixture = (name: string): BoardSnapshot => JSON.parse(readFileSync(join(__dirname, '..', 'server/fixtures/development', `${name}.v1.json`), 'utf8')).board;
const seatPanel = (page: Page) => page.getByRole('region', { name: 'Your turn', exact: true });

function choices(board: BoardSnapshot, seat: Power, ids: string[]): ChallengeLegalCatalog['options'] {
  return ids.map(id => {
    const [unitTerritory, kind, destination] = id.split('|'), [targetTerritory, targetCoast] = destination?.split('/') ?? [];
    const order = { id, power: seat, unitTerritory, unitCoast: board.units.find(unit => unit.territory === unitTerritory)?.coast ?? null,
      type: kind === 'HOLD' ? 'HOLD' : 'MOVE', targetTerritory: targetTerritory ?? null, targetCoast: targetCoast ?? null,
      supportedUnit: null, supportedDestination: null, viaConvoy: kind === 'MOVE_VIA_CONVOY' } as Order;
    return { id, unitTerritory, order, description: id };
  });
}

async function showSeat(page: Page, name: string, board: BoardSnapshot, seat: Power, ids: string[], failLegal = false) {
  const { origin } = JSON.parse(readFileSync(join(__dirname, '.state.json'), 'utf8'));
  let response = await page.request.get('/api/full-games/ui-audit-seed');
  if (response.status() === 404) {
    const started = await page.request.post('/api/full-games', { headers: { Origin: origin }, data: { runId: 'ui-audit-seed', until: 1901, messages: 0, live: false } });
    expect(started.ok()).toBe(true);
  }
  let game: LiveGame;
  await expect.poll(async () => {
    response = await page.request.get('/api/full-games/ui-audit-seed');
    if (!response.ok()) return false;
    game = await response.json();
    return game.status === 'FINISHED';
  }).toBe(true);
  game = structuredClone(game!);
  game.run.runId = name;
  game.run.assignment[seat] = 'human';
  game.settings.seat = seat;
  game.status = 'WAITING';
  game.current = board;
  game.live = { ...game.live, running: true, status: 'RUNNING', waitingFor: { kind: 'ACT', phaseId: `${name}:${board.year}:${board.season}:${board.phase}` } };
  const catalog = { attemptId: game.run.attemptId, phaseId: game.live.waitingFor!.phaseId, revision: 0, options: choices(board, seat, ids) };
  const submissions: Array<{ phaseId: string; action: { phase: string; orderIds?: string[]; builds?: unknown[] } }> = [];
  let legalCalls = 0;
  await page.route(`**/api/full-games/${name}`, route => route.fulfill({ json: game }));
  await page.route(`**/api/full-games/${name}/legal`, route => {
    legalCalls++;
    return failLegal && legalCalls === 1 ? route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: 'Temporary catalog outage' } }) : route.fulfill({ json: catalog });
  });
  await page.route(`**/api/full-games/${name}/act`, route => {
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: { accepted: true } });
  });
  await page.goto(`/viewer#/db/${name}`);
  await expect(seatPanel(page)).toBeVisible();
  if (board.phase === 'ORDERS') await seatPanel(page).getByRole('tab', { name: /Orders/ }).click();
  return { game, submissions };
}

test('a player with no units can build again or waive the builds', async ({ page }) => {
  const board = fixture('winter-build');
  board.units = board.units.filter(unit => unit.power !== 'FRANCE');
  const { submissions, game } = await showSeat(page, 'build-without-units', board, 'FRANCE', []);
  const panel = seatPanel(page), submit = panel.getByRole('button', { name: 'Submit orders', exact: true });
  await expect(submit).toBeEnabled();
  const build = panel.getByRole('combobox', { name: 'Build in Paris', exact: true });
  await build.selectOption('ARMY');
  await submit.click();
  await panel.getByRole('button', { name: 'Yes, submit', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toEqual({ phaseId: game.live.waitingFor!.phaseId, action: { phase: 'BUILDS', builds: [{ territory: 'PAR', type: 'ARMY', coast: null }], disbands: [] } });
  await build.selectOption('');
  await submit.click();
  await panel.getByRole('button', { name: 'Yes, submit', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].action.builds).toEqual([]);
});

test('an allied convoy remains submittable and Space activates the seat button rather than replay', async ({ page }) => {
  const board = fixture('allied-convoy');
  const { submissions } = await showSeat(page, 'allied-convoy-ui', board, 'ENGLAND', ['LON|HOLD', 'LON|MOVE_VIA_CONVOY|BEL', 'NTH|HOLD']);
  const panel = seatPanel(page);
  await panel.getByLabel('Order for the army in London', { exact: true }).selectOption('LON|MOVE_VIA_CONVOY|BEL');
  await expect(panel).toContainText('none of your fleets');
  const submit = panel.getByRole('button', { name: 'Submit orders', exact: true });
  await expect(submit).toBeEnabled();
  await submit.focus();
  await page.keyboard.press('Space');
  await expect(panel.getByRole('button', { name: 'Yes, submit', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Yes, submit', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].action.orderIds).toContain('LON|MOVE_VIA_CONVOY|BEL');
});

test('map movement into a friendly occupied province preserves circular moves', async ({ page }) => {
  const board = fixture('circular-moves');
  await showSeat(page, 'circular-moves-ui', board, 'FRANCE', ['PAR|HOLD', 'PAR|MOVE|BUR', 'BUR|HOLD', 'BUR|MOVE|GAS', 'GAS|HOLD', 'GAS|MOVE|PAR']);
  const panel = seatPanel(page);
  await panel.locator('.unit-marker[data-territory="PAR"]').click();
  await panel.locator('.unit-marker[data-territory="BUR"]').click();
  await expect(panel.getByLabel('Order for the army in Paris', { exact: true })).toHaveValue('PAR|MOVE|BUR');
});

test('split-coast map movement asks for the coast and submits the chosen one', async ({ page }) => {
  const board = fixture('split-coast');
  const { submissions } = await showSeat(page, 'split-coast-ui', board, 'ENGLAND', ['MAO|HOLD', 'MAO|MOVE|SPA/NORTH', 'MAO|MOVE|SPA/SOUTH']);
  const panel = seatPanel(page), fleet = panel.getByLabel('Order for the fleet in Mid-Atlantic Ocean', { exact: true });
  await expect(fleet).toBeEnabled();
  await panel.locator('.unit-marker[data-territory="MAO"]').click();
  const spain = await panel.locator('.province-shape[data-territory="SPA"]').boundingBox();
  expect(spain).not.toBeNull();
  await page.mouse.click(spain!.x + spain!.width / 2, spain!.y + spain!.height / 2);
  const coasts = panel.getByRole('group', { name: 'Choose destination coast' });
  await expect(coasts).toBeVisible();
  await expect(fleet).toHaveValue('MAO|HOLD');
  await coasts.getByRole('button', { name: 'south coast', exact: true }).click();
  await expect(fleet).toHaveValue('MAO|MOVE|SPA/SOUTH');
  await panel.getByRole('button', { name: 'Submit orders', exact: true }).click();
  await panel.getByRole('button', { name: 'Yes, submit', exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].action.orderIds).toEqual(['MAO|MOVE|SPA/SOUTH']);
});

test('a transient legal-order outage can be retried without reloading the game', async ({ page }) => {
  const board = fixture('split-coast');
  await showSeat(page, 'retry-legal-ui', board, 'ENGLAND', ['MAO|HOLD', 'MAO|MOVE|SPA/SOUTH'], true);
  const panel = seatPanel(page);
  await expect(panel.getByRole('alert')).toContainText('Temporary catalog outage');
  await panel.getByRole('button', { name: /Retry legal orders/ }).click();
  await expect(panel.getByLabel('Order for the fleet in Mid-Atlantic Ocean', { exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Submit orders', exact: true })).toBeEnabled();
});

test('Games home starts a free human-seat game, advances a turn, and keeps it in the library', async ({ page }) => {
  const runId = 'games-home-journey';
  const { origin } = JSON.parse(readFileSync(join(__dirname, '.state.json'), 'utf8'));
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Set up a game', exact: true }).click();
    await page.getByRole('combobox', { name: 'Your power', exact: true }).selectOption('FRANCE');
    await page.getByText('More settings', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Game name', exact: true }).fill(runId);
    await page.getByRole('button', { name: 'Start the game', exact: true }).click();
    const panel = seatPanel(page);
    await expect(panel.getByRole('button', { name: 'Finish writing · say nothing', exact: true })).toBeVisible({ timeout: 15_000 });
    await panel.getByRole('button', { name: 'Finish writing · say nothing', exact: true }).click();
    await panel.getByRole('tab', { name: /Orders/ }).click();
    const submit = panel.getByRole('button', { name: 'Submit orders', exact: true });
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();
    await panel.getByRole('button', { name: 'Yes, submit', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Fall 1901 · orders', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Pause the game', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue (free)', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: 'Games', exact: true }).click();
    const yours = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: runId, exact: true }) });
    await expect(yours).toContainText('You play France');
    await expect(yours.getByRole('link', { name: 'Continue', exact: true })).toBeVisible();
  } finally {
    await page.request.post(`/api/full-games/${runId}/stop`, { headers: { Origin: origin }, data: {} });
  }
});
