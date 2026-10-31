import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

test('detected hooks default to Keep yours and never claim to edit them', async ({ page }) => {
  await openPrefs(page, 'hooks=Stop,SessionStart');
  await tab(page, 'Sound hooks');
  await expect(page.getByText('never edits them')).toBeVisible();
  const table = page.getByTestId('hooks-table');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  for (const ev of ['Stop', 'SessionStart']) {
    const row = table.locator(`[data-hook-event="${ev}"]`);
    await expect(row.getByRole('radio', { name: 'Keep yours' })).toBeChecked();
    await expect(row.getByRole('radio', { name: 'Play both' })).not.toBeChecked();
    await expect(row).toContainText('afplay');
  }
  // Stop overlaps "Turn complete"; SessionStart overlaps "Session start".
  await expect(table.locator('[data-hook-event="Stop"]')).toContainText('Turn complete');
  await expect(table.locator('[data-hook-event="SessionStart"]')).toContainText('Session start');
});

test('Play both is saved per event', async ({ page }) => {
  await openPrefs(page, 'hooks=Stop,SessionStart');
  await tab(page, 'Sound hooks');
  await page.locator('[data-hook-event="Stop"]').getByRole('radio', { name: 'Play both' }).check();
  const policy = await page.evaluate(() => window.__PR_PREFS__.store.getPrefs().sound.hookPolicy);
  expect(policy).toEqual({ Stop: 'both' });
  await expect(
    page.locator('[data-hook-event="SessionStart"]').getByRole('radio', { name: 'Keep yours' }),
  ).toBeChecked();
});

test('no hooks detected says so', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sound hooks');
  await expect(page.getByTestId('hooks-empty')).toContainText('No sound hooks found');
});
