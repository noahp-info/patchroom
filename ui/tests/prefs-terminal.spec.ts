import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

const bg = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__PR_PREFS__.fakeTerm.options.theme?.background);

test('a per-DM palette and font restyle that live terminal only', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Terminal');
  const before = await bg(page);
  await page.getByLabel('hook-bridge palette').selectOption('solarized-dark');
  await expect.poll(() => bg(page)).toBe('#002b36');
  await page.getByLabel('hook-bridge font', { exact: true }).selectOption('Menlo');
  await page.getByLabel('hook-bridge font size').selectOption('16');
  const opts = await page.evaluate(() => window.__PR_PREFS__.fakeTerm.options);
  expect(opts.fontFamily).toContain('"Menlo"');
  expect(opts.fontSize).toBe(16);
  // Another DM keeps the default.
  const other = await page.evaluate(() => {
    const h = window.__PR_PREFS__;
    return h.termStyleFor(h.store.getPrefs(), 'dm-beta').theme.background;
  });
  expect(other).toBe(before);
  // Back to the default clears the override.
  await page.getByLabel('hook-bridge palette').selectOption('');
  await expect.poll(() => bg(page)).toBe(before);
});

test('the default row applies to every DM without its own style', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Terminal');
  await page.getByLabel('All DMs palette').selectOption('iterm');
  await expect.poll(() => bg(page)).toBe('#000000');
  await expect(page.getByTestId('term-row-dm-beta').getByTestId('term-preview')).toHaveAttribute(
    'data-palette',
    'iterm',
  );
});

test('the terminal follows the app theme in each mode', async ({ page }) => {
  await openPrefs(page);
  await page.getByRole('radio', { name: 'Light' }).check({ force: true });
  const light = await bg(page);
  await page.getByRole('radio', { name: 'Dark' }).check({ force: true });
  await expect.poll(() => bg(page)).not.toBe(light);
});
