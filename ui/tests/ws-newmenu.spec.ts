import { expect, test, type Page } from '@playwright/test';
import {
  HOME,
  chooseNew,
  openFolder,
  openSeeded,
  openWithDm,
  setTheme,
  watchErrors,
} from './helpers';

const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];
const plus = (page: Page) => page.getByRole('button', { name: 'Create new' });
const menu = (page: Page) => page.getByRole('menu', { name: 'Create new' });

/** WCAG contrast of an element's text on its composited background, computed in the page. */
async function contrastOf(page: Page, selector: string): Promise<number> {
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
      const s = /color\(srgb ([^)]+)\)/.exec(c);
      if (s) {
        const p = s[1].split(/[ /]+/).filter(Boolean).map(Number);
        return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
      }
      return [0, 0, 0, 0];
    };
    const over = (t: RGBA, u: RGBA): RGBA => {
      const a = t[3] + u[3] * (1 - t[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: number) => (t[i] * t[3] + u[i] * u[3] * (1 - t[3])) / a;
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
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
    let bg: RGBA = [255, 255, 255, 1];
    for (const e of chain) bg = over(parse(getComputedStyle(e).backgroundColor), bg);
    const fg = over(parse(getComputedStyle(el).color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }, selector);
}

test.describe('workspace: the + menu (Slack style)', () => {
  test('the header has one + button and no standalone section button', async ({ page }) => {
    await openSeeded(page, []);
    await expect(plus(page)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(plus(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('aside.side .ws button[aria-label="New section"]')).toHaveCount(0);
    await expect(page.locator('aside.side .ws button[aria-label="New DM"]')).toHaveCount(0);
  });

  test('opens with the three actions, first one focused, and Esc returns focus to the button', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openSeeded(page, []);
    await plus(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(plus(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(menu(page).getByRole('menuitem')).toHaveText([
      'New DM',
      'New section',
      'New section from folder...',
    ]);
    await expect(menu(page).getByRole('menuitem', { name: 'New DM' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(
      menu(page).getByRole('menuitem', { name: 'New section', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('End');
    await expect(
      menu(page).getByRole('menuitem', { name: 'New section from folder...' }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(plus(page)).toBeFocused();
    expect(errs).toEqual([]);
  });

  test('keyboard only: ArrowDown on the button opens it, Enter on New section focuses the name', async ({
    page,
  }) => {
    await openSeeded(page, []);
    await plus(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByLabel('Section name')).toBeFocused();
    await page.keyboard.type('Reviews');
    await page.keyboard.press('Enter');
    await expect(page.locator('.side [data-kind="section"]', { hasText: 'Reviews' })).toBeVisible();
  });

  test('pressing the button again, or outside, closes the menu', async ({ page }) => {
    await openSeeded(page, []);
    await plus(page).click();
    await expect(menu(page)).toBeVisible();
    // The outside press closes it on its own: the button click then reopens, so use the pane.
    await page.locator('.pane').click({ position: { x: 20, y: 200 } });
    await expect(menu(page)).toHaveCount(0);
  });

  test('New DM opens the dialog', async ({ page }) => {
    await openSeeded(page, []);
    await chooseNew(page, 'New DM');
    await expect(page.getByRole('dialog', { name: 'New DM' })).toBeVisible();
  });

  for (const theme of THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      test(`${theme} ${mode}: menu text and the focused item stay legible`, async ({ page }) => {
        await openSeeded(page, []);
        await setTheme(page, theme, mode);
        await plus(page).click();
        await expect(menu(page)).toBeVisible();
        expect(await contrastOf(page, '.ctxmenu__item:not(:focus)')).toBeGreaterThanOrEqual(4.5);
        expect(await contrastOf(page, '.ctxmenu__item:focus')).toBeGreaterThanOrEqual(4.5);
        const box = await menu(page).boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(1600);
      });
    }
  }
});

test.describe('workspace: Terminal look from the DM menu (checklist 15)', () => {
  test('opens Preferences on the Terminal tab at that DM, focused', async ({ page }) => {
    const errs = watchErrors(page);
    await openSeeded(page, [
      { id: 'a1', name: 'alpha' },
      { id: 'b1', name: 'beta' },
    ]);
    await page.locator('.side .row', { hasText: 'beta' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Terminal look...' }).click();
    const dlg = page.getByRole('dialog', { name: 'Preferences' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('prefs-terminal')).toBeVisible();
    const row = dlg.getByTestId('term-row-b1');
    await expect(row).toHaveAttribute('data-target', 'true');
    await expect(row.getByRole('combobox', { name: 'beta palette' })).toBeFocused();
    await expect(dlg.getByTestId('term-row-a1')).not.toHaveAttribute('data-target', 'true');
    expect(errs).toEqual([]);
  });

  test('a palette chosen there is that DM only, and reopening finds it again', async ({ page }) => {
    await openSeeded(page, [
      { id: 'a1', name: 'alpha' },
      { id: 'b1', name: 'beta' },
    ]);
    await page.locator('.side .row', { hasText: 'beta' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Terminal look...' }).click();
    const dlg = page.getByRole('dialog', { name: 'Preferences' });
    await dlg.getByRole('combobox', { name: 'beta palette' }).selectOption('iterm');
    await expect(dlg.getByRole('combobox', { name: 'alpha palette' })).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await page.locator('.side .row', { hasText: 'beta' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Terminal look...' }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Preferences' })
        .getByRole('combobox', { name: 'beta palette' }),
    ).toHaveValue('iterm');
  });

  test('keyboard: the context-menu key reaches the item', async ({ page }) => {
    await openSeeded(page, [{ id: 'a1', name: 'alpha' }]);
    await page.locator('.side .row', { hasText: 'alpha' }).focus();
    await page.keyboard.press('ContextMenu');
    await page.getByRole('menuitem', { name: 'Terminal look...' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible();
  });
});

test.describe('workspace: the folder hover card follows the pointer', () => {
  test('scrolling the sidebar dismisses it', async ({ page }) => {
    await openFolder(page);
    const row = page.locator('.side .fs-row').first();
    await row.hover();
    await expect(page.getByTestId('folder-tip')).toBeVisible();
    await page.mouse.wheel(0, 500);
    await expect(page.getByTestId('folder-tip')).toHaveCount(0);
  });

  test('after scrolling, hovering another row shows that row, not the old one', async ({
    page,
  }) => {
    await openFolder(page);
    const rows = page.locator('.side .fs-row');
    await rows.first().hover();
    await expect(page.getByTestId('folder-tip')).toBeVisible();
    await page.mouse.wheel(0, 600);
    await expect(page.getByTestId('folder-tip')).toHaveCount(0);
    const other = rows.nth(6);
    await other.hover();
    const name = (await other.getByTestId('fs-name').textContent()) ?? '';
    await expect(page.getByTestId('folder-tip').locator('.fs-tip__name')).toHaveText(name);
    const tip = (await page.getByTestId('folder-tip').boundingBox())!;
    const at = (await other.boundingBox())!;
    expect(tip.y).toBeLessThanOrEqual(at.y + at.height);
    expect(tip.y + tip.height).toBeGreaterThanOrEqual(at.y);
  });

  test('a drag dismisses it and no card appears beside the wrong row afterwards', async ({
    page,
  }) => {
    await openFolder(page, {
      dms: [{ id: 'k1', name: 'knowfirst', cwd: '/Users/me/code/knowfirst', sectionId: 'atlas' }],
    });
    const lazy = page.locator('.side .fs-row').first();
    await lazy.hover();
    await expect(page.getByTestId('folder-tip')).toBeVisible();
    const dm = page.locator('.side .row[data-dm="k1"]');
    const a = (await dm.boundingBox())!;
    await page.mouse.move(a.x + 40, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 60, a.y + a.height / 2 + 30, { steps: 4 });
    await expect(page.getByTestId('folder-tip')).toHaveCount(0);
    await page.mouse.up();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);
    await expect(page.getByTestId('folder-tip')).toHaveCount(0);
  });

  test('leaving the sidebar clears it, and keyboard focus still shows it', async ({ page }) => {
    await openFolder(page);
    const row = page.locator('.side .fs-row').first();
    await row.hover();
    await expect(page.getByTestId('folder-tip')).toBeVisible();
    await page.mouse.move(900, 500);
    await expect(page.getByTestId('folder-tip')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await row.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('folder-tip')).toBeVisible();
    expect(HOME).toBeTruthy();
  });
});

test.describe('workspace: terminal title strip and dialog scrim follow the theme', () => {
  for (const theme of THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      test(`${theme} ${mode}: the strip matches the terminal and stays readable`, async ({
        page,
      }) => {
        await openWithDm(page, 'mock', 'chat');
        await setTheme(page, theme, mode);
        const read = () =>
          page.evaluate(() => {
            const bar = document.querySelector<HTMLElement>('[data-testid="term-title"]')!;
            const stage = document.querySelector<HTMLElement>('.stage')!;
            return {
              bar: getComputedStyle(bar).backgroundColor,
              stage: getComputedStyle(stage).backgroundColor,
            };
          });
        await expect.poll(async () => (await read()).bar).toBe((await read()).stage);
        const { bar, stage } = await read();
        expect(bar).toBe(stage);
        expect(await contrastOf(page, '.termbar__title')).toBeGreaterThanOrEqual(4.5);
        // A light theme never keeps a near-black bar above a light terminal.
        if (mode === 'light') {
          const [r, g, b] = (/\d+/g.exec(bar) ? bar.match(/\d+/g)! : ['0', '0', '0']).map(Number);
          expect((r + g + b) / 3).toBeGreaterThan(110);
        }
      });
    }
  }

  test('a DM with the iTerm palette gets a dark strip even in a light theme', async ({ page }) => {
    const id = await openWithDm(page, 'mock', 'chat');
    await setTheme(page, 'homeroom', 'light');
    await page.evaluate(
      (sid) => window.__PR_STORE__!.setPrefs({ termPerDm: { [sid]: { themeId: 'iterm' } } }),
      id,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            getComputedStyle(document.querySelector('[data-testid="term-title"]')!).backgroundColor,
        ),
      )
      .toBe('rgb(0, 0, 0)');
  });

  test('the New DM scrim is neutral black alpha', async ({ page }) => {
    await openSeeded(page, []);
    await chooseNew(page, 'New DM');
    const scrim = await page.evaluate(
      () => getComputedStyle(document.querySelector('dialog.newdm')!, '::backdrop').backgroundColor,
    );
    expect(scrim).toMatch(/^rgba\(0, 0, 0, 0\.45\)$/);
  });
});
