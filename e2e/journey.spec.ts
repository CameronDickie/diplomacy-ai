import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

type State = { origin: string; cookieName: string; cookies: Record<'practice' | 'sponsored' | 'leaver' | 'bot' | 'operator', string> };
const state = (): State => JSON.parse(readFileSync(join(__dirname, '.state.json'), 'utf8'));
const signIn = async (context: BrowserContext, who: keyof State['cookies']) => {
  const s = state();
  await context.addCookies([{ name: s.cookieName, value: s.cookies[who], url: s.origin, httpOnly: true, sameSite: 'Lax' }]);
};
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const content = (page: Page) => page.locator('#dip-content');
const phase = (page: Page) => page.getByLabel('Current phase');
const section = (page: Page, name: string) => page.getByLabel('Game sections').getByRole('button', { name });

test('a visitor without an account can read the challenge and step through the reference replay', async ({ page }) => {
  await page.goto('/challenge');
  await expect(page.getByLabel('Your mission')).toBeVisible();
  await expect(content(page)).toContainText(/own .+ after Fall \d{4} or sooner/);
  // The ways to play are set side by side, each saying who decides the opponents.
  await expect(page.getByRole('heading', { name: 'Choose how to play' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Practice bot' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Controls practice' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How this challenge works' })).toBeVisible();
  await expect(content(page)).toContainText('Legal is not successful');
  await expect(content(page)).toContainText(/starts? per account per UTC day/);
  await expect(page.getByRole('button', { name: 'Start practice' })).toBeDisabled();
  // A visitor is shown today's challenge only.
  await expect(page.getByRole('heading', { name: 'Choose a challenge' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Watch reference replay' }).click();
  const controls = page.getByLabel('Replay controls');
  await expect(controls).toContainText('Reference replay');
  const next = controls.getByRole('button', { name: 'Next' });
  for (let i = 0; i < 40 && await next.isEnabled(); i++) await next.click();
  await expect(controls).toContainText('Result');
  await controls.getByRole('button', { name: /Return to/ }).click();
  await expect(controls).toHaveCount(0);
  await page.goto('/legal.html');
  await expect(page.getByRole('heading', { name: 'Credits and licenses' })).toBeVisible();
});

test('the public page fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/challenge');
  await expect(page.getByLabel('Your mission')).toBeVisible();
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: 'Watch reference replay' }).click();
  await expect(page.getByLabel('Replay controls')).toBeVisible();
  await noSidewaysScroll(page);
});

test('a signed-in player plays a practice turn, keeps a chosen order through the replay, and resumes after a reload', async ({ page, context }) => {
  await signIn(context, 'practice');
  await page.goto('/challenge');
  await page.getByRole('button', { name: 'Start practice' }).click();
  await expect(phase(page)).toHaveText('Spring 1901 · orders');
  const order = page.locator('.dip-orders select').first();
  await expect(order).toBeEnabled();
  const move = await order.locator('option').evaluateAll(options => (options as HTMLOptionElement[]).find(o => / moves to /.test(o.text))!.value);
  await order.selectOption(move);
  // Watching the reference replay does not disturb the attempt or the choice just made.
  await section(page, 'Setup').click();
  await expect(content(page)).toContainText('You have a game in progress');
  await page.getByRole('button', { name: 'Watch reference replay' }).click();
  await expect(content(page)).toContainText('Your game is untouched while you watch');
  await page.getByRole('button', { name: 'Return to your game' }).click();
  await section(page, 'Play').click();
  await expect(order).toHaveValue(move);
  await page.getByRole('button', { name: 'Submit orders' }).click();
  await expect(phase(page)).toHaveText('Fall 1901 · orders', { timeout: 20_000 });
  await expect(page.getByLabel('Opponents')).toContainText('Controls practice');
  // The orders log lives in its own place, with every power's orders and results, and can be shown on the map.
  await section(page, 'History').click();
  await expect(page.getByRole('heading', { name: 'Spring 1901', exact: true })).toBeVisible();
  await expect(content(page).locator('tr.is-own').first()).toContainText('(you)');
  await page.getByRole('button', { name: 'Show Spring 1901 on the map' }).click();
  await expect(page.getByLabel('Replay controls')).toContainText('Your game');
  await page.getByRole('button', { name: 'Return to the orders log' }).click();
  await expect(page.getByRole('heading', { name: 'Spring 1901', exact: true })).toBeVisible();
  await section(page, 'Play').click();
  await page.reload();
  await expect(phase(page)).toHaveText('Fall 1901 · orders');
  await page.getByRole('button', { name: 'Abandon attempt' }).click();
  await page.getByRole('button', { name: 'End attempt' }).click();
  await expect(page.getByLabel('Attempt result')).toContainText('Attempt abandoned');
});

test('the practice bot is the main free way to play: labelled, and its opponents move', async ({ page, context }) => {
  await signIn(context, 'bot');
  await page.goto('/challenge');
  // On a development server any signed-in account may pick a challenge other than today's; the page follows the choice.
  const library = page.getByRole('region', { name: 'Choose a challenge' });
  const todays = await page.getByRole('heading', { level: 1 }).innerText();
  const pick = library.getByRole('button', { name: /^Select/ }).first();
  const picked = (await pick.innerText()).replace(/^Select\s*/, '').trim();
  await pick.click();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(todays);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(picked);
  await expect(content(page)).toContainText('chosen from the library');
  await page.getByRole('button', { name: 'Play against the practice bot' }).click();
  expect(await page.evaluate(async () => (await (await fetch('/api/attempts', { credentials: 'include' })).json()).attempts[0].challenge.title)).toBe(picked);
  await expect(page.getByLabel('Opponents')).toContainText('Practice bot');
  await expect(content(page)).toContainText('free scripted opponents, no AI model');
  await expect(page.getByRole('button', { name: 'Submit orders' })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit orders' }).click();
  await expect(phase(page)).toHaveText('Fall 1901 · orders', { timeout: 20_000 });
  const moved = await page.evaluate(async () => {
    const attempt = (await (await fetch('/api/attempts', { credentials: 'include' })).json()).attempts[0];
    const reports = (await (await fetch(`/api/attempts/${attempt.id}/reports`, { credentials: 'include' })).json()).reports;
    return reports[0].resolvedOrders.filter((o: { power: string; type: string }) => o.power !== attempt.challenge.humanPower && o.type === 'MOVE').length;
  });
  expect(moved).toBeGreaterThan(5);
});

test('a sponsored attempt against the mock opponents is labelled as such and the opponents move', async ({ page, context }) => {
  await signIn(context, 'sponsored');
  await page.goto('/challenge');
  await page.getByRole('button', { name: 'Play against mock model opponents' }).click();
  await expect(page.getByLabel('Opponents')).toContainText('Mock model opponents');
  await expect(content(page)).toContainText('development stand-in, no provider calls');
  await expect(page.getByRole('button', { name: 'Submit orders' })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit orders' }).click();
  await expect(phase(page)).toHaveText('Fall 1901 · orders', { timeout: 30_000 });
  const reports = await page.evaluate(async () => {
    const attempts = (await (await fetch('/api/attempts', { credentials: 'include' })).json()).attempts;
    return (await (await fetch(`/api/attempts/${attempts[0].id}/reports`, { credentials: 'include' })).json()).reports;
  });
  const human = await page.evaluate(async () => (await (await fetch('/api/attempts', { credentials: 'include' })).json()).attempts[0].challenge.humanPower);
  expect(reports[0].resolvedOrders.some((o: { power: string; type: string }) => o.power !== human && o.type !== 'HOLD')).toBe(true);
});

test('the operator sees attempts and budget, can pause and resume paid play, and a player cannot open the operator view', async ({ page, context, browser }) => {
  await signIn(context, 'operator');
  await page.goto('/challenge');
  await page.getByRole('button', { name: 'Operator', exact: true }).click();
  const panel = page.getByLabel('Operator controls');
  await expect(panel.getByRole('heading', { name: 'Capacity' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Budget' })).toBeVisible();
  await expect(panel).toContainText('Settled (all time)');
  await expect(panel).toContainText('sponsored');
  await panel.getByRole('button', { name: 'Watch' }).first().click();
  await expect(panel).toContainText('Watching attempt');
  await panel.getByRole('button', { name: 'Stop new paid calls' }).click();
  await panel.getByRole('button', { name: 'Confirm stop' }).click();
  await expect(panel.getByRole('button', { name: 'Resume paid calls' })).toBeVisible();
  // A visitor now sees sponsored play as paused, with no second start button.
  const visitor = await browser.newContext(), guest = await visitor.newPage();
  await guest.goto(`${state().origin}/challenge`);
  await expect(guest.locator('#dip-content')).toContainText('Sponsored play against GPT-6 Luna is paused');
  await expect(guest.getByRole('button', { name: /Luna opponents/ })).toHaveCount(0);
  await visitor.close();
  await panel.getByRole('button', { name: 'Resume paid calls' }).click();
  await panel.getByRole('button', { name: 'Confirm resume' }).click();
  await expect(panel.getByRole('button', { name: 'Stop new paid calls' })).toBeVisible();
  await expect(panel).toContainText('PAID_STOP');
  // A bot exhibition game: started here, played in the background, watchable by anyone.
  await panel.getByRole('button', { name: 'Start one on today’s scenario' }).click();
  await expect(panel.locator('.operator-list').filter({ hasText: 'phases' }).first()).toContainText(/RUNNING|COMPLETED|STALLED/);
  const watcher = await browser.newContext(), watching = await watcher.newPage();
  await watching.goto(`${state().origin}/challenge`);
  const entry = watching.locator('.dip-list li').filter({ hasText: /phases/ }).first().getByRole('button', { name: 'Watch' });
  await expect(entry).toBeEnabled({ timeout: 30_000 });
  await entry.click();
  await expect(watching.getByLabel('Replay controls')).toContainText('Exhibition');
  await expect(watching.locator('#dip-content')).toContainText('played entirely by the free practice bot');
  await watcher.close();
  await page.setViewportSize({ width: 375, height: 812 });
  await noSidewaysScroll(page);
  const player = await browser.newContext();
  await signIn(player, 'practice');
  const other = await player.newPage();
  await other.goto(`${state().origin}/challenge`);
  await expect(other.getByRole('button', { name: 'Start practice' })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Operator', exact: true })).toHaveCount(0);
  expect((await other.request.get(`${state().origin}/api/operator/overview`)).status()).toBe(403);
  await player.close();
});

test('a player can delete their account and is signed out with nothing left behind', async ({ page, context }) => {
  await signIn(context, 'leaver');
  await page.goto('/challenge');
  await page.getByRole('button', { name: 'Start practice' }).click();
  await expect(phase(page)).toBeVisible();
  await section(page, 'Setup').click();
  await page.getByRole('button', { name: 'Delete account and data…' }).click();
  await expect(page.getByLabel('Your account')).toContainText('permanently removes your sign-in identity');
  await page.getByRole('button', { name: 'Delete account and data', exact: true }).click();
  await expect(page.getByLabel('Your account')).toHaveCount(0);
  await expect(phase(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start practice' })).toBeDisabled();
  expect((await page.request.get('/api/attempts')).status()).toBe(401);
});
