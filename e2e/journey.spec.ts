import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

type State = { origin: string; cookieName: string; cookies: Record<'practice' | 'sponsored' | 'leaver' | 'operator', string> };
const state = (): State => JSON.parse(readFileSync(join(__dirname, '.state.json'), 'utf8'));
const signIn = async (context: BrowserContext, who: keyof State['cookies']) => {
  const s = state();
  await context.addCookies([{ name: s.cookieName, value: s.cookies[who], url: s.origin, httpOnly: true, sameSite: 'Lax' }]);
};
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const brief = (page: Page) => page.locator('.challenge-brief');

test('a visitor without an account can read the challenge and step through the reference replay', async ({ page }) => {
  await page.goto('/challenge');
  await expect(brief(page).getByRole('heading', { name: 'Your mission' })).toBeVisible();
  await expect(brief(page)).toContainText(/own .+ after Fall \d{4} or sooner/);
  await expect(page.getByText('How this challenge works')).toBeVisible();
  await expect(brief(page)).toContainText('Legal is not successful');
  await expect(brief(page)).toContainText(/starts? per account per UTC day/);
  await expect(page.getByRole('button', { name: 'Start practice' })).toBeDisabled();
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
  await expect(brief(page).getByRole('heading', { name: 'Your mission' })).toBeVisible();
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: 'Watch reference replay' }).click();
  await expect(page.getByLabel('Replay controls')).toBeVisible();
  await noSidewaysScroll(page);
});

test('a signed-in player plays a practice turn, keeps a chosen order through the replay, and resumes after a reload', async ({ page, context }) => {
  await signIn(context, 'practice');
  await page.goto('/challenge');
  await page.getByRole('button', { name: 'Start practice' }).click();
  await expect(page.locator('.challenge-phase')).toHaveText('1901 SPRING · ORDERS');
  const order = page.locator('.challenge-orders select').first();
  await expect(order).toBeEnabled();
  const move = await order.locator('option').evaluateAll(options => (options as HTMLOptionElement[]).find(o => / moves to /.test(o.text))!.value);
  await order.selectOption(move);
  // Watching the reference replay does not disturb the attempt or the choice just made.
  await page.getByRole('button', { name: 'Watch reference replay' }).click();
  await expect(page.locator('.challenge-orders')).toContainText('Your attempt is untouched while you watch');
  await page.getByRole('button', { name: 'Return to your attempt' }).click();
  await expect(order).toHaveValue(move);
  await page.getByRole('button', { name: 'Submit orders' }).click();
  await expect(page.locator('.challenge-phase')).toHaveText('1901 FALL · ORDERS', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: /1901 SPRING · ORDERS/ })).toBeVisible();
  await expect(page.locator('.challenge-badge')).toContainText('Offline practice');
  await page.reload();
  await expect(page.locator('.challenge-phase')).toHaveText('1901 FALL · ORDERS');
  await page.getByRole('button', { name: 'Abandon attempt' }).click();
  await page.getByRole('button', { name: 'End attempt' }).click();
  await expect(page.getByLabel('Attempt result')).toContainText('Attempt abandoned');
});

test('a sponsored attempt against the mock opponents is labelled as such and the opponents move', async ({ page, context }) => {
  await signIn(context, 'sponsored');
  await page.goto('/challenge');
  await page.getByRole('button', { name: 'Play against mock Luna opponents' }).click();
  await expect(page.locator('.challenge-badge')).toContainText('Mock Luna opponents');
  await expect(brief(page)).toContainText('development stand-in, no provider calls');
  await expect(page.getByRole('button', { name: 'Submit orders' })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit orders' }).click();
  await expect(page.locator('.challenge-phase')).toHaveText('1901 FALL · ORDERS', { timeout: 30_000 });
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
  await expect(guest.locator('.challenge-brief')).toContainText('Sponsored play against GPT-6 Luna is paused');
  await expect(guest.getByRole('button', { name: /Play against/ })).toHaveCount(0);
  await visitor.close();
  await panel.getByRole('button', { name: 'Resume paid calls' }).click();
  await panel.getByRole('button', { name: 'Confirm resume' }).click();
  await expect(panel.getByRole('button', { name: 'Stop new paid calls' })).toBeVisible();
  await expect(panel).toContainText('PAID_STOP');
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
  await expect(page.locator('.challenge-phase')).toBeVisible();
  await page.getByRole('button', { name: 'Delete account and data…' }).click();
  await expect(page.locator('.challenge-account')).toContainText('permanently removes your sign-in identity');
  await page.getByRole('button', { name: 'Delete account and data', exact: true }).click();
  await expect(page.locator('.challenge-account')).toHaveCount(0);
  await expect(page.locator('.challenge-phase')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start practice' })).toBeDisabled();
  expect((await page.request.get('/api/attempts')).status()).toBe(401);
});
