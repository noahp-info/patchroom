import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { headerOf, openSidebarDemo } from './helpers';

/**
 * Rendered readability of the sidebar, held to WCAG AA by axe-core's `color-contrast` rule (text
 * 4.5:1, large text 3:1) in every shipped theme, light and dark. The same standard the proQueue
 * mobile QA applies. A failure names the element and the measured pair.
 *
 * Three states are scanned per theme and mode so every sidebar surface is covered: the open
 * sidebar with the hover card, a folded divider group (needs-you rows and header counts), and
 * the live-session confirm with the Older list open.
 */
const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];
const SIDEBAR = ['aside.side', '.fs-tip', '.floating'];

async function scan(page: Page, label: string): Promise<void> {
  let b = new AxeBuilder({ page }).withRules(['color-contrast']);
  for (const s of SIDEBAR) if (await page.locator(s).count()) b = b.include(s);
  const r = await b.analyze();
  const bad = r.violations.flatMap((v) =>
    v.nodes.map((n) => `${n.target.join(' ')}: ${n.any[0]?.message ?? v.help}`),
  );
  expect(bad, `${label}: color-contrast violations`).toEqual([]);
  // Every node must be decided: an "incomplete" result is text axe could not measure.
  const unsure = r.incomplete.flatMap((v) => v.nodes.map((n) => n.target.join(' ')));
  expect(unsure, `${label}: color-contrast could not be measured`).toEqual([]);
  expect(r.passes[0]?.nodes.length ?? 0, `${label}: the scan checked text`).toBeGreaterThan(20);
}

for (const theme of THEMES) {
  for (const mode of ['light', 'dark'] as const) {
    test(`axe color-contrast: ${theme} ${mode}`, async ({ page }) => {
      // Tall enough that nothing scrolls: axe cannot measure a row half clipped by a scroller.
      await page.setViewportSize({ width: 1600, height: 2600 });
      await openSidebarDemo(page, { id: theme, mode });
      // Reduced motion and a settled layout, so a mid-transition color is never measured.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(150);

      // 1. Open sidebar: headers, emoji, dividers, rows, chips, badges, and the hover card.
      await page.locator('[data-fs-session="gn-010"]').hover();
      await expect(page.getByRole('tooltip')).toBeVisible();
      await scan(page, `${theme} ${mode} open + hover card`);

      // 2. A folded divider group: needs-you rows under it and header counts.
      await page.mouse.move(900, 500);
      await headerOf(page, 'div-side').click();
      await headerOf(page, 'gn').click();
      await expect(page.locator('[data-testid="needs-peek"]').first()).toBeVisible();
      await page.mouse.move(900, 500);
      await scan(page, `${theme} ${mode} folded`);

      // 3. The Older list and the live-session confirm.
      await headerOf(page, 'gn').click();
      await headerOf(page, 'div-side').click();
      await page.locator('.fs-older').click();
      await page.evaluate(() =>
        window.__PR_MOCK__!.patchFolderSession('gn', 'gn-025', { liveElsewhere: true }),
      );
      await expect(page.locator('[data-fs-session="gn-025"] [data-chip="live"]')).toBeVisible();
      await page.locator('[data-fs-session="gn-025"]').click();
      await expect(page.getByTestId('fs-confirm')).toBeVisible();
      await page.mouse.move(900, 500);
      await scan(page, `${theme} ${mode} older + confirm`);

      // 4. The + menu, the create row and the emoji picker.
      await page.getByTestId('fs-confirm').getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Create new' }).click();
      await expect(page.getByRole('menu', { name: 'Create new' })).toBeVisible();
      await scan(page, `${theme} ${mode} + menu`);
      await page.getByRole('menuitem', { name: 'New divider', exact: true }).click();
      await scan(page, `${theme} ${mode} create row`);
      await page.getByTestId('sec-emoji-btn').click();
      await expect(page.getByRole('dialog', { name: 'Section emoji' })).toBeVisible();
      await scan(page, `${theme} ${mode} emoji picker`);
    });
  }
}
