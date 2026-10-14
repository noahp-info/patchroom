import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

test('default and per-DM levels persist through prefs_set', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Notifications');
  await page.getByLabel('Default notification level').selectOption('needs');
  await page.getByLabel('docs-site notification level').selectOption('mute');
  const n = await page.evaluate(() => window.__PR_PREFS__.store.getPrefs().notify);
  expect(n).toEqual({ default: 'needs', perDm: { 'dm-beta': 'mute' } });
  await page.getByLabel('docs-site notification level').selectOption('');
  const n2 = await page.evaluate(() => window.__PR_PREFS__.store.getPrefs().notify);
  expect(n2.perDm).toEqual({});
});

test('the test button calls notify_test', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Notifications');
  await page.getByRole('button', { name: 'Send test notification' }).click();
  await expect(page.getByText('Test notification sent.')).toBeVisible();
  expect(await page.evaluate(() => window.__PR_PREFS__.api.notifyTests)).toBe(1);
});

test('prefs:changed from the backend updates the open pane', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Notifications');
  await page.evaluate(async () => {
    const h = window.__PR_PREFS__;
    await h.api.prefsSet({ notify: { default: 'mute', perDm: {} } });
  });
  await expect(page.getByLabel('Default notification level')).toHaveValue('mute');
});
