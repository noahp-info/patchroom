import { expect, test, type Page } from '@playwright/test';
import { HOME, openFolder, setTheme } from './helpers';

const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];

/** WCAG contrast of an element's text against its composited background, computed in the page. */
async function contrast(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (m) {
        const p = m[1]
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number);
        return [p[0], p[1], p[2], p[3] ?? 1];
      }
      // color(srgb r g b / a)
      const s = /color\(srgb ([^)]+)\)/.exec(c);
      if (s) {
        const p = s[1].split(/[ /]+/).filter(Boolean).map(Number);
        return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
      }
      return [0, 0, 0, 0];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const lum = (c: RGBA) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    // Composite the background from the root down.
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
    let bg: RGBA = [255, 255, 255, 1];
    for (const e of chain) bg = over(parse(getComputedStyle(e).backgroundColor), bg);
    const fg = over(parse(getComputedStyle(el).color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }, selector);
}

test.describe('workspace: folder sections in every theme, light and dark (checklist 16)', () => {
  for (const theme of THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      test(`${theme} ${mode}: legible rows, chips, confirm, hover card and no overflow`, async ({
        page,
      }, testInfo) => {
        await openFolder(page, {
          dms: [
            { id: 'k1', name: 'knowfirst', cwd: '/Users/me/code/knowfirst', sectionId: 'atlas' },
            { id: 'n1', name: 'needs-dm', cwd: HOME, sectionId: 'atlas', status: 'waiting' },
          ],
        });
        await setTheme(page, theme, mode);
        await page.locator('.fs-older').click();
        await page.locator('[data-fs-session="fx-003"]').click();
        await expect(page.getByTestId('fs-confirm')).toBeVisible();

        const min = 4.5;
        for (const sel of [
          '.fs-row [data-testid="fs-name"]',
          '.fs-row .fs-age',
          '.fs-row [data-chip="branch"]',
          '.fs-row [data-chip="path"]',
          '.fs-row [data-chip="live"]',
          '.fs-toggle',
          '.fs-confirm p',
          '.fs-confirm .fs-btn:not(.fs-btn--pri)',
          '.fs-confirm .fs-btn--pri',
          '[data-testid="folder-chip"]',
          '.sec-hint, .sec-name',
        ]) {
          const c = await contrast(page, `.side ${sel.split(', ').join(', .side ')}`);
          expect(c, `${theme} ${mode}: ${sel} contrast ${c.toFixed(2)}`).toBeGreaterThanOrEqual(
            min,
          );
        }

        await page.getByTestId('fs-confirm').getByRole('button', { name: 'Cancel' }).click();
        await page.locator('[data-fs-session="fx-001"]').hover();
        const tip = page.getByRole('tooltip');
        await expect(tip).toBeVisible();
        for (const sel of ['.fs-tip__name', '.fs-tip__prompt', '.fs-tip__meta']) {
          const c = await contrast(page, `.fs-tip ${sel}`);
          expect(c, `${theme} ${mode}: tip ${sel} contrast ${c.toFixed(2)}`).toBeGreaterThanOrEqual(
            min,
          );
        }
        const fit = await page.evaluate(() => {
          const s = document.querySelector('.side-scroll')!;
          const t = document.querySelector('.fs-tip')!.getBoundingClientRect();
          return { overflow: s.scrollWidth - s.clientWidth, tipIn: t.right <= window.innerWidth };
        });
        expect(fit.overflow).toBeLessThanOrEqual(0);
        expect(fit.tipIn).toBe(true);
        await testInfo.attach(`${theme}-${mode}.png`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      });
    }
  }

  test('the section menu and the Older editor use surface tokens in both modes', async ({
    page,
  }) => {
    await openFolder(page);
    for (const mode of ['light', 'dark'] as const) {
      await setTheme(page, 'homeroom', mode);
      await page.locator('.side [data-group="atlas"] .sec-h').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Older than 14 days...' }).click();
      const c = await contrast(page, '.fs-days label > span:first-child');
      expect(c).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');
    }
  });
});
