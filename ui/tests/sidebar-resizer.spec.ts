import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openSidebarDemo } from './helpers';

/**
 * The sidebar resizer (drag handle, 220 to 420px, saved in prefs, double-click resets to 264,
 * arrow keys on the focused handle) and branch-chip legibility at every width it can take.
 */
const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];
const WIDTHS = [220, 264, 420];

const sideWidth = (page: Page) =>
  page.evaluate(() => Math.round(document.querySelector('.side')!.getBoundingClientRect().width));
const savedWidth = (page: Page) => page.evaluate(() => window.__PR_MOCK__!.prefs().sidebarWidth);
const handle = (page: Page) => page.getByRole('separator', { name: 'Resize sidebar' });

async function setWidth(page: Page, w: number): Promise<void> {
  await page.evaluate((v) => window.__PR_STORE__!.setPrefs({ sidebarWidth: v }), w);
  await expect.poll(() => sideWidth(page)).toBe(w);
}

async function drag(page: Page, dx: number): Promise<void> {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 200;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test.describe('sidebar resizer', () => {
  test('defaults to 264px with an accessible separator', async ({ page }) => {
    await openSidebarDemo(page, { id: 'homeroom', mode: 'light' });
    await expect.poll(() => sideWidth(page)).toBe(264);
    const h = handle(page);
    await expect(h).toHaveAttribute('aria-orientation', 'vertical');
    await expect(h).toHaveAttribute('aria-valuemin', '220');
    await expect(h).toHaveAttribute('aria-valuemax', '420');
    await expect(h).toHaveAttribute('aria-valuenow', '264');
    expect(await savedWidth(page)).toBe(264);
  });

  test('dragging resizes live, clamps at 220 and 420, and saves through prefs', async ({
    page,
  }) => {
    await openSidebarDemo(page, { id: 'homeroom', mode: 'light' });
    await drag(page, 60);
    await expect.poll(() => sideWidth(page)).toBe(324);
    await expect.poll(() => savedWidth(page)).toBe(324);
    await expect(handle(page)).toHaveAttribute('aria-valuenow', '324');
    await drag(page, 500);
    await expect.poll(() => sideWidth(page)).toBe(420);
    await expect.poll(() => savedWidth(page)).toBe(420);
    await drag(page, -900);
    await expect.poll(() => sideWidth(page)).toBe(220);
    await expect.poll(() => savedWidth(page)).toBe(220);
  });

  test('double-click resets to 264', async ({ page }) => {
    await openSidebarDemo(page, { id: 'homeroom', mode: 'light' });
    await setWidth(page, 380);
    await handle(page).dblclick();
    await expect.poll(() => sideWidth(page)).toBe(264);
    await expect.poll(() => savedWidth(page)).toBe(264);
  });

  test('arrow keys on the focused handle resize; Shift is a big step; Home and End jump', async ({
    page,
  }) => {
    await openSidebarDemo(page, { id: 'homeroom', mode: 'light' });
    await page.keyboard.press('Tab');
    await handle(page).focus();
    await expect(handle(page)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => sideWidth(page)).toBe(280);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => sideWidth(page)).toBe(248);
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => sideWidth(page)).toBe(296);
    await page.keyboard.press('End');
    await expect.poll(() => sideWidth(page)).toBe(420);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => sideWidth(page)).toBe(420);
    await page.keyboard.press('Home');
    await expect.poll(() => sideWidth(page)).toBe(220);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => sideWidth(page)).toBe(220);
    await page.keyboard.press('Enter');
    await expect.poll(() => sideWidth(page)).toBe(264);
    await expect.poll(() => savedWidth(page)).toBe(264);
  });

  test('the width survives a restart; a stored blob without it loads 264', async ({ page }) => {
    await page.goto('/?mock&persist&sidebar-demo');
    await page.waitForFunction(() => !!window.__PR_STORE__ && !!window.__PR_MOCK__);
    await setWidth(page, 332);
    await expect.poll(() => savedWidth(page)).toBe(332);
    await page.reload();
    await page.waitForFunction(() => !!window.__PR_STORE__ && !!window.__PR_MOCK__);
    await expect.poll(() => sideWidth(page)).toBe(332);
    // An out-of-range value in a stored blob is held to the limits.
    await page.evaluate(() => window.__PR_STORE__!.setPrefs({ sidebarWidth: 9999 }));
    await expect.poll(() => sideWidth(page)).toBe(420);
  });
});

test.describe('branch chips are legible at every sidebar width', () => {
  for (const theme of THEMES) {
    for (const w of WIDTHS) {
      test(`${theme} at ${w}px: distinguishing segment, nothing clipped`, async ({ page }) => {
        await openSidebarDemo(page, { id: theme, mode: 'light' });
        await setWidth(page, w);
        const chips = page.locator('.side [data-folder-body="gn"] [data-chip="branch"]');
        expect(await chips.count()).toBeGreaterThan(2);
        const rows = await chips.evaluateAll((els) =>
          els.map((chip) => {
            const text = chip.querySelector(':scope > span') as HTMLElement;
            const row = chip.closest('.row') as HTMLElement;
            const nm = row.querySelector('.nm') as HTMLElement;
            const cr = chip.getBoundingClientRect();
            const rr = row.getBoundingClientRect();
            return {
              text: text.textContent ?? '',
              title: chip.getAttribute('title') ?? '',
              textClipped: text.scrollWidth > text.clientWidth,
              chipClipped: (chip as HTMLElement).scrollWidth > (chip as HTMLElement).clientWidth,
              inside: cr.left >= rr.left - 0.5 && cr.right <= rr.right + 0.5,
              rowOverflow: row.scrollWidth > row.clientWidth,
              nameWidth: nm.clientWidth,
              oneLine: Math.round(rr.height) <= 32,
            };
          }),
        );
        for (const r of rows) {
          expect(r.text, 'chip shows the last segment').toMatch(/^lane-\d+$/);
          expect(r.title).toBe(`feat/${r.text}`);
          expect(r.textClipped, `${r.title} text is clipped`).toBe(false);
          expect(r.chipClipped, `${r.title} chip is clipped`).toBe(false);
          expect(r.inside, `${r.title} sits inside its row`).toBe(true);
          expect(r.rowOverflow, `${r.title} row overflows`).toBe(false);
          expect(r.nameWidth, `${r.title} keeps some of the session name`).toBeGreaterThan(40);
          expect(r.oneLine).toBe(true);
        }
        // The name gives way first: a long name is cut, the chip is not.
        const cut = await page.evaluate(() => {
          const nms = Array.from(
            document.querySelectorAll<HTMLElement>('.side [data-folder-body="gn"] .row .nm'),
          );
          return nms.some((n) => n.scrollWidth > n.clientWidth);
        });
        if (w === 220) expect(cut).toBe(true);
      });
    }
  }
});

test.describe('axe color-contrast at every sidebar width', () => {
  for (const theme of ['homeroom', 'patch-bay']) {
    for (const mode of ['light', 'dark'] as const) {
      for (const w of WIDTHS) {
        test(`${theme} ${mode} at ${w}px`, async ({ page }) => {
          await page.setViewportSize({ width: 1600, height: 2600 });
          await openSidebarDemo(page, { id: theme, mode });
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await setWidth(page, w);
          await page.locator('[data-fs-session="gn-004"]').hover();
          await expect(page.getByRole('tooltip')).toBeVisible();
          const r = await new AxeBuilder({ page })
            .withRules(['color-contrast'])
            .include('aside.side')
            .include('.fs-tip')
            .analyze();
          const bad = r.violations.flatMap((v) =>
            v.nodes.map((n) => `${n.target.join(' ')}: ${n.any[0]?.message ?? v.help}`),
          );
          expect(bad).toEqual([]);
          expect(r.incomplete.flatMap((v) => v.nodes.map((n) => n.target.join(' ')))).toEqual([]);
          expect(r.passes[0]?.nodes.length ?? 0).toBeGreaterThan(20);
        });
      }
    }
  }
});
