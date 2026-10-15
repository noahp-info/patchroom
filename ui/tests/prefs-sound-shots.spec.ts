import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

/**
 * Screenshots of the whole Sounds pane in every theme, light and dark, with the states that have
 * their own colors filled in: a pack in use, volumes off 100 percent, your own file, an imported
 * Claude profile, a muted DM and a DM with its own gain. Each run attaches the images to the
 * report. Set SOUND_SHOTS_DIR to also write them to disk (tests/screenshots/ holds the last set).
 */
const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];

for (const theme of THEMES) {
  for (const mode of ['light', 'dark'] as const) {
    test(`Sounds pane screenshot: ${theme} ${mode}`, async ({ page }, testInfo) => {
      await openPrefs(page);
      await page.evaluate(
        ([themeId, m]) =>
          window.__PR_PREFS__.store.update({ themeId, mode: m as 'light' | 'dark' }),
        [theme, mode],
      );
      await page.waitForFunction(
        ([t, m]) => {
          const el = document.querySelector('.pr-app');
          return el?.getAttribute('data-theme') === t && el?.getAttribute('data-mode') === m;
        },
        [theme, mode],
      );
      await tab(page, 'Sounds');
      await page.getByRole('button', { name: 'Use Lab Glass for every event' }).click();
      await page.getByRole('slider', { name: 'Needs you volume', exact: true }).fill('1.5');
      await page.getByRole('slider', { name: 'Terminal bell volume', exact: true }).fill('0.4');
      await page.evaluate(
        () => void (window.__PR_PREFS__.api.sound.control.nextPick = '/Users/me/Sounds/knock.m4a'),
      );
      await page.getByLabel('Error source', { exact: true }).selectOption('__file');
      await expect(page.getByLabel('Error source', { exact: true })).toHaveValue(/^custom:/);
      await page.getByRole('button', { name: 'Import your Claude sounds' }).click();
      await page.getByRole('button', { name: 'Import default profile' }).click();
      await page.getByText('Imported default.').waitFor();
      await page.getByLabel('Mute sounds for docs-site').check();
      await page.getByTestId('sound-dm-dm-alpha').locator('summary').click();
      await page
        .getByRole('slider', { name: 'hook-bridge Needs you volume', exact: true })
        .fill('0.6');
      await page.setViewportSize({ width: 1600, height: 4400 });
      await page.addStyleTag({
        content:
          '.prefs{height:auto!important;max-height:none!important}.prefs__main{overflow:visible!important}',
      });
      const shot = await page.getByRole('dialog', { name: 'Preferences' }).screenshot();
      expect(shot.length).toBeGreaterThan(10_000);
      await testInfo.attach(`sounds-${theme}-${mode}.png`, {
        body: shot,
        contentType: 'image/png',
      });
      const dir = process.env.SOUND_SHOTS_DIR;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        await page
          .getByRole('dialog', { name: 'Preferences' })
          .screenshot({ path: `${dir}/sounds-${theme}-${mode}.png` });
      }
    });
  }
}
