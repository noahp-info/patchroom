import { expect, test } from '@playwright/test';
import { openSeeded, watchErrors } from './helpers';

test.describe('workspace: prefs, sounds and notifications wiring', () => {
  test('Cmd+, opens the preferences pane and Esc closes it', async ({ page }) => {
    const errs = watchErrors(page);
    await openSeeded(page, [{ id: 'a', name: 'alpha' }]);
    await page.keyboard.press('Meta+,');
    await expect(page.getByRole('dialog', { name: /settings/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /settings/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog', { name: /settings/i })).toBeVisible();
    expect(errs).toEqual([]);
  });

  test('prefs read and written through the app IPC reach the pane and the app', async ({
    page,
  }) => {
    await openSeeded(page, [{ id: 'a', name: 'alpha' }]);
    await page.evaluate(() => window.__PR_STORE__!.setPrefs({ themeId: 'patch-bay' }));
    expect((await page.evaluate(() => window.__PR_MOCK__!.prefs())).themeId).toBe('patch-bay');
    await expect(page.locator('.pr-app')).toHaveAttribute('data-theme', 'patch-bay');
  });

  test('notify:fire plays one sound per event', async ({ page }) => {
    await openSeeded(page, [{ id: 'a', name: 'alpha' }]);
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.fireNotify({ id: 'a', event: 'needs', title: 'alpha', body: 'Bash wants permission' });
      m.fireNotify({ id: 'a', event: 'done', title: 'alpha', body: 'Finished' });
    });
    const log = await page.evaluate(() => window.__PR_SOUND_LOG__);
    expect(log?.map((l) => `${l.id}:${l.event}`)).toEqual(['a:needs', 'a:done']);
  });

  test('the backend is told which DM is on screen', async ({ page }) => {
    await openSeeded(page, [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
    ]);
    await page.locator('.side .row', { hasText: 'beta' }).click();
    await page.locator('.side .row', { hasText: 'alpha' }).click();
    const calls = await page.evaluate(() => window.__PR_MOCK__!.focusCalls);
    expect(calls.filter((c) => c !== null).slice(-2)).toEqual(['b', 'a']);
  });

  test('a click on a native notification opens that DM', async ({ page }) => {
    await openSeeded(page, [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
    ]);
    await page.evaluate(() => window.__PR_STORE__!.openDm('a'));
    await page.evaluate(() => window.__PR_MOCK__!.emitNotifyOpen('b'));
    await expect
      .poll(() => page.evaluate(() => window.__PR_STORE__!.getSnapshot().activeId))
      .toBe('b');
  });

  test('OSC titles show as the DM subtitle', async ({ page }) => {
    await openSeeded(page, [{ id: 'a', name: 'alpha' }]);
    await page.evaluate(() => window.__PR_MOCK__!.setTitle('a', 'Fixing the bridge timeout'));
    await expect(page.getByTestId('row-subtitle')).toHaveText('Fixing the bridge timeout');
  });
});
