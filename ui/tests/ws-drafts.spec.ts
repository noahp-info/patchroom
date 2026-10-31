import { expect, test } from '@playwright/test';
import { openSeeded, watchErrors } from './helpers';

const DMS = [
  { id: 'a', name: 'alpha' },
  { id: 'b', name: 'beta' },
];
const box = (page: import('@playwright/test').Page) => page.getByTestId('composer-input');
const mark = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.side .row', { hasText: name }).getByTestId('draft-mark');

test.describe('workspace: drafts (checklist 7)', () => {
  test('an unsent draft survives switching DMs and shows a pencil marker', async ({ page }) => {
    const errs = watchErrors(page);
    await openSeeded(page, DMS);
    await page.evaluate(() => window.__PR_STORE__!.openDm('a'));
    await box(page).fill('half a thought about the bridge');
    await expect(mark(page, 'alpha')).toBeVisible();
    await expect(mark(page, 'beta')).toHaveCount(0);
    // Switch away at once: the draft is flushed on the switch, not left to the debounce.
    await page.locator('.side .row', { hasText: 'beta' }).click();
    await expect(box(page)).toHaveValue('');
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.drafts['a']))
      .toBe('half a thought about the bridge');
    await page.locator('.side .row', { hasText: 'alpha' }).click();
    await expect(box(page)).toHaveValue('half a thought about the bridge');
    // Sending clears the draft and the marker.
    await box(page).press('Enter');
    await expect(mark(page, 'alpha')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__PR_MOCK__!.drafts['a'])).toBeUndefined();
    expect(errs).toEqual([]);
  });

  test('typing is saved after a short pause, and clearing the text deletes the draft', async ({
    page,
  }) => {
    await openSeeded(page, DMS);
    await page.evaluate(() => window.__PR_STORE__!.openDm('a'));
    await box(page).fill('one');
    await box(page).fill('one two');
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.drafts['a']), { timeout: 3000 })
      .toBe('one two');
    // Debounced: two quick edits make one write.
    const writes = await page.evaluate(
      () => window.__PR_MOCK__!.draftSets.filter((d) => d.id === 'a').length,
    );
    expect(writes).toBe(1);
    await box(page).fill('');
    await expect.poll(() => page.evaluate(() => window.__PR_MOCK__!.drafts['a'])).toBeUndefined();
    await expect(mark(page, 'alpha')).toHaveCount(0);
  });

  test('a draft survives an app restart', async ({ page }) => {
    await openSeeded(page, DMS, { query: 'mock&persist' });
    await page.evaluate(() => window.__PR_STORE__!.openDm('b'));
    await box(page).fill('draft that outlives the app');
    await expect.poll(() => page.evaluate(() => window.__PR_MOCK__!.drafts['b'])).toBeTruthy();
    await page.reload();
    // The restarted app lists the DM with its pencil marker before the DM is opened.
    await expect(mark(page, 'beta')).toBeVisible();
    await page.locator('.side .row', { hasText: 'beta' }).click();
    await expect(box(page)).toHaveValue('draft that outlives the app');
  });
});

test('each DM keeps its own view when you switch away and back', async ({ page }) => {
  await openSeeded(page, DMS);
  await page.locator('.side .row', { hasText: 'alpha' }).click();
  await page.keyboard.press('Meta+j');
  await expect(page.getByTestId('view-label')).toHaveText('Terminal');
  await page.locator('.side .row', { hasText: 'beta' }).click();
  await expect(page.getByTestId('view-label')).toHaveText('Chat');
  await page.locator('.side .row', { hasText: 'alpha' }).click();
  await expect(page.getByTestId('view-label')).toHaveText('Terminal');
  // And across a restart.
  await page.reload();
  await page.waitForFunction(() => !!window.__PR_STORE__);
  expect(await page.evaluate(() => window.__PR_STORE__!.viewOf('a'))).toBe('terminal');
});
