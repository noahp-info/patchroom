import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const WIDTHS = [880, 1200, 1600];

async function setFullscreen(page: Page, on: boolean) {
  await page.evaluate(
    (v) => window.dispatchEvent(new CustomEvent('pr:fullscreen', { detail: v })),
    on,
  );
}

for (const width of WIDTHS) {
  test.describe(`top bar at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('keeps 84px clear on the left for the window controls', async ({ page }) => {
      await page.goto('/?mock');
      const tb = page.getByTestId('topbar');
      await expect(tb).toHaveCSS('padding-left', '84px');
      const box = (await tb.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(40);
      // Nothing interactive starts inside the controls zone.
      const firstLeft = await tb.evaluate((el) => {
        const kids = Array.from(el.querySelectorAll('button')) as HTMLElement[];
        return Math.min(...kids.map((k) => k.getBoundingClientRect().left));
      });
      expect(firstLeft).toBeGreaterThanOrEqual(84);
      // The workspace header below the bar is not under it.
      const side = (await page.locator('.side').boundingBox())!;
      expect(side.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
    });

    test('empty areas are drag regions and controls are not', async ({ page }) => {
      await page.goto('/?mock');
      const tb = page.getByTestId('topbar');
      await expect(tb).toHaveAttribute('data-tauri-drag-region', 'true');
      const spacers = tb.locator('.tb-spacer');
      expect(await spacers.count()).toBe(2);
      for (let i = 0; i < 2; i++) {
        await expect(spacers.nth(i)).toHaveAttribute('data-tauri-drag-region', 'true');
      }
      for (const b of await tb.locator('button').all()) {
        await expect(b).not.toHaveAttribute('data-tauri-drag-region', /.*/);
      }
      expect(await tb.locator('button [data-tauri-drag-region]').count()).toBe(0);
    });

    test('search and Needs you stay interactive', async ({ page }) => {
      await page.goto('/?mock');
      const search = page.getByRole('button', { name: 'Jump to a DM' });
      await expect(search).toBeVisible();
      await expect(search).toBeEnabled();
      await search.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      // Nothing waits on the user in the plain mock, so the Needs you button stays hidden.
      await expect(page.locator('.tb-act')).toHaveCount(0);
    });

    test('full screen collapses the inset and keeps the height', async ({ page }) => {
      await page.goto('/?mock');
      const tb = page.getByTestId('topbar');
      const before = (await tb.boundingBox())!;
      await setFullscreen(page, true);
      await expect(page.locator('.pr-app')).toHaveAttribute('data-fullscreen', 'true');
      await expect(tb).toHaveCSS('padding-left', '14px');
      expect((await tb.boundingBox())!.height).toBe(before.height);
      await setFullscreen(page, false);
      await expect(tb).toHaveCSS('padding-left', '84px');
    });
  });
}

test('the page draws no title text in the bar', async ({ page }) => {
  await page.goto('/?mock');
  await expect(page.getByTestId('topbar').getByText('Patchroom', { exact: true })).toHaveCount(0);
});
