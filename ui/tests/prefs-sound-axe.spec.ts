import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];

/** Fill the Sounds pane with every state that has its own colors. */
async function populate(page: Page) {
  await page.getByRole('button', { name: 'Use Lab Glass for every event' }).click();
  await page.evaluate(
    () => void (window.__PR_PREFS__.api.sound.control.nextPick = '/Users/me/Sounds/theme-song.mp3'),
  );
  await page.getByLabel('Needs you source', { exact: true }).selectOption('__file');
  await page.getByRole('alert').first().waitFor();
  await page.getByRole('button', { name: 'Import your Claude sounds' }).click();
  await page.getByRole('button', { name: 'Import default profile' }).click();
  await page.getByText('Imported default.').waitFor();
  await page.getByLabel('Mute sounds for docs-site').check();
  await page.getByTestId('sound-dm-dm-alpha').locator('summary').click();
  await page.getByLabel('Pack for hook-bridge').selectOption('switchboard');
}

for (const theme of THEMES) {
  for (const mode of ['light', 'dark'] as const) {
    test(`Sounds pane passes axe color-contrast: ${theme} ${mode}`, async ({ page }) => {
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
      await populate(page);
      // The pane scrolls, and axe skips what a scroller clips. Lay the whole pane out instead.
      await page.setViewportSize({ width: 1600, height: 4200 });
      await page.addStyleTag({
        content:
          '.prefs{height:auto!important;max-height:none!important}.prefs__main{overflow:visible!important}',
      });
      const res = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      const bad = res.violations.flatMap((v) =>
        v.nodes.map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`),
      );
      expect(bad).toEqual([]);
      // The checks reached the bottom of the pane.
      const reached = res.passes
        .flatMap((p) => p.nodes)
        .some((n) => n.target.join(' ').includes('credits'));
      expect(reached).toBe(true);
    });
  }
}
