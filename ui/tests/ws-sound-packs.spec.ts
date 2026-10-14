import { expect, test } from '@playwright/test';
import { openSeeded, watchErrors } from './helpers';
import { audio, spyAudio } from './prefs-helpers';

test.describe('workspace: sound packs', () => {
  test.beforeEach(async ({ page }) => {
    await spyAudio(page);
  });

  test('the DM menu opens Preferences on Sounds with that DM open', async ({ page }) => {
    const errs = watchErrors(page);
    await openSeeded(page, [
      { id: 'a1', name: 'alpha' },
      { id: 'b1', name: 'beta' },
    ]);
    await page.locator('.side .row', { hasText: 'beta' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Sounds...' }).click();
    const dlg = page.getByRole('dialog', { name: 'Preferences' });
    await expect(dlg.getByTestId('prefs-sounds')).toBeVisible();
    await expect(dlg.getByTestId('sound-dm-b1')).toHaveJSProperty('open', true);
    await expect(dlg.getByTestId('sound-dm-a1')).toHaveJSProperty('open', false);
    await expect(dlg.getByRole('combobox', { name: 'Pack for beta' })).toBeFocused();
    expect(errs).toEqual([]);
  });

  test('the app lists all 11 packs from the IPC', async ({ page }) => {
    await openSeeded(page, [{ id: 'a1', name: 'alpha' }]);
    const n = await page.evaluate(async () => (await window.__PR_STORE__!.ipc.soundPacks()).length);
    expect(n).toBe(11);
  });

  test('notify:fire plays exactly one sound, through the DM override', async ({ page }) => {
    await openSeeded(page, [
      { id: 'a1', name: 'alpha' },
      { id: 'b1', name: 'beta' },
    ]);
    await page.evaluate(async () => {
      const p = window.__PR_MOCK__!.prefs();
      await window.__PR_STORE__!.setPrefs({
        sound: { ...p.sound, perDm: { b1: { pack: 'switchboard' } } },
      });
    });
    // alpha: default Patch Tones through the oscillators.
    await page.evaluate(() =>
      window.__PR_MOCK__!.fireNotify({ id: 'a1', event: 'done', title: 'alpha', body: 'Done' }),
    );
    await expect.poll(async () => (await audio(page)).osc).toBeGreaterThan(0);
    expect((await audio(page)).files).toHaveLength(0);
    // beta: its own pack, a file, and no oscillators on top.
    const osc = (await audio(page)).osc;
    await page.evaluate(() =>
      window.__PR_MOCK__!.fireNotify({ id: 'b1', event: 'done', title: 'beta', body: 'Done' }),
    );
    await expect.poll(async () => (await audio(page)).files.length).toBe(1);
    expect((await audio(page)).osc).toBe(osc);
    const log = await page.evaluate(() => window.__PR_SOUND_LOG__);
    expect(log?.map((l) => `${l.id}:${l.event}`)).toEqual(['a1:done', 'b1:done']);
  });
});
