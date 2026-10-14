import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

/**
 * The mix board sits at the top of the Sounds pane, under the master volume, so a user can change
 * and level a sound without scrolling past the pack cards.
 */
const EVENTS = ['needs', 'done', 'message', 'error', 'bell', 'decision', 'due', 'session'] as const;

test.use({ viewport: { width: 1200, height: 800 } });

test('mix board and all 8 event rows sit in the first viewport', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  const vh = page.viewportSize()!.height;
  const main = page.locator('.prefs__main');
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
  const board = await page.getByTestId('mix-board').boundingBox();
  expect(board!.y).toBeGreaterThan(0);
  expect(board!.y).toBeLessThan(vh / 2);
  const dialog = (await page.getByRole('dialog', { name: 'Preferences' }).boundingBox())!;
  for (const e of EVENTS) {
    const row = (await page.getByTestId(`mix-${e}`).boundingBox())!;
    expect(row.y, e).toBeGreaterThanOrEqual(0);
    expect(row.y + row.height, e).toBeLessThanOrEqual(vh);
    expect(row.y + row.height, `${e} inside the dialog`).toBeLessThanOrEqual(
      dialog.y + dialog.height,
    );
  }
  // The pack cards come after the mix.
  const pack = (await page.getByTestId('pack-patchtones').boundingBox())!;
  const last = (await page.getByTestId('mix-session').boundingBox())!;
  expect(pack.y).toBeGreaterThan(last.y);
  await expect(page.getByRole('button', { name: 'Play the whole mix' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Reset to Patch Tones' })).toBeInViewport();
});

test('changing and leveling one sound needs no scroll', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  const main = page.locator('.prefs__main');
  await page.getByLabel('Session start source', { exact: true }).selectOption('pack:lab-glass');
  await page.getByRole('slider', { name: 'Session start volume', exact: true }).fill('0.5');
  await page.getByRole('button', { name: 'Test Session start sound' }).click();
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
  const mix = await page.evaluate(() => window.__PR_PREFS__.store.getPrefs().sound.mix.session);
  expect(mix).toEqual({ pack: 'lab-glass', gain: 0.5 });
});

test('master and per-event sliders use the accent token', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  const colors = await page.locator('.sounds-pane input[type=range]').evaluateAll((els) => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--accent)';
    document.querySelector('.pr-app')!.append(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return els.map((el) => [getComputedStyle(el).accentColor, want]);
  });
  expect(colors.length).toBeGreaterThan(8);
  for (const [got, want] of colors) expect(got).toBe(want);
});

test('Use for every event scrolls back to the mix and marks what changed', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  const main = page.locator('.prefs__main');
  const btn = page.getByRole('button', { name: 'Use Lab Glass for every event' });
  await btn.scrollIntoViewIfNeeded();
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await btn.click();
  await expect(page.getByTestId('mix-needs')).toHaveAttribute('data-changed', 'true');
  await expect(page.getByTestId('mix-board')).toBeInViewport();
  await expect(page.getByRole('status').filter({ hasText: 'Lab Glass now plays' })).toBeVisible();
  await expect(page.getByLabel('Needs you source', { exact: true })).toHaveValue('pack:lab-glass');
});

test('Reset puts every event back on Patch Tones', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  await page.getByLabel('Error source', { exact: true }).selectOption('off');
  await page.getByRole('button', { name: 'Reset to Patch Tones' }).click();
  await expect(page.getByLabel('Error source', { exact: true })).toHaveValue('pack:patchtones');
});

test('Play the whole mix previews every non-off event', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  await page.getByLabel('Terminal bell source', { exact: true }).selectOption('off');
  const before = await page.evaluate(() => window.__PR_PREFS__.soundLog.length);
  await page.getByRole('button', { name: 'Play the whole mix' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__PR_PREFS__.soundLog.length), { timeout: 10_000 })
    .toBe(before + 7);
});
