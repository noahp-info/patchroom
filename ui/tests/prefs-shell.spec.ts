import { expect, test } from '@playwright/test';

// Preferences inside the real app shell (not the harness): no collisions with workspace CSS,
// no overflow, in every shipped theme, both modes, at the default and minimum window sizes.
const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];
const SIZES = [
  { width: 1200, height: 800 },
  { width: 880, height: 520 },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    for (const mode of ['Light', 'Dark']) {
      test(`prefs in the app shell: ${theme} ${mode} at ${size.width}x${size.height}`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.goto('/?mock&grid=100x30');
        await page.keyboard.press('Meta+,');
        const dlg = page.getByRole('dialog', { name: 'Preferences' });
        await expect(dlg).toBeVisible();
        await page.locator(`[data-theme-card="${theme}"]`).click();
        await page.getByRole('radio', { name: mode, exact: true }).check();

        const seg = await page.locator('.pf-seg').first().boundingBox();
        expect(seg!.width).toBeLessThan(360);

        const bad = await page.evaluate(() => {
          const out: string[] = [];
          const root = document.querySelector<HTMLElement>('dialog.prefs')!;
          for (const el of [root as HTMLElement, ...root.querySelectorAll<HTMLElement>('*')]) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none') continue;
            if (
              el.scrollWidth > el.clientWidth + 1 &&
              cs.overflowX === 'visible' &&
              el.clientWidth > 0
            )
              out.push(`${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}`);
          }
          return out.slice(0, 5);
        });
        expect(bad).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      });
    }
  }
}
