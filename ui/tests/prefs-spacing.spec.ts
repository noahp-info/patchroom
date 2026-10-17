import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';
import { ringFindings } from './qa';

/*
 * Spacing rule (DESIGN.md): a control row and the hint text next to it are at least one group
 * gap (`--group-gap`, 12px) apart. Checked on every Settings tab: each visible `.pf-hint` against
 * the sibling above and below it when that sibling is or holds a control.
 */
const TABS = [
  'Themes',
  'Terminal',
  'Status bar',
  'Notifications',
  'Sounds',
  'Do Not Disturb',
  'Sound hooks',
  'Links',
];

test('no control row sits closer than the group gap to the hint text beside it', async ({
  page,
}) => {
  await openPrefs(page);
  const gap = await page
    .locator('.pr-app')
    .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--group-gap')));
  expect(gap).toBe(12);
  const tight: string[] = [];
  for (const t of TABS) {
    await tab(page, t);
    const found = await page.locator('.prefs__main').evaluate((main, min) => {
      const CTL = 'button, input, select, textarea';
      const shown = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const isCtl = (e: Element) => e.matches(CTL) || !!e.querySelector(CTL);
      const sib = (e: Element, dir: 'previousElementSibling' | 'nextElementSibling') => {
        let s = e[dir];
        while (s && !shown(s)) s = s[dir];
        return s;
      };
      const out: string[] = [];
      for (const hint of main.querySelectorAll('.pf-hint')) {
        if (!shown(hint) || hint.closest('button, label, li, small')) continue;
        const h = hint.getBoundingClientRect();
        const name = (e: Element) => (e.textContent ?? '').trim().slice(0, 50);
        const above = sib(hint, 'previousElementSibling');
        if (above && isCtl(above)) {
          const d = h.top - above.getBoundingClientRect().bottom;
          if (d >= -1 && d < min - 0.5) out.push(`${d}px above "${name(hint)}"`);
        }
        const below = sib(hint, 'nextElementSibling');
        if (below && isCtl(below)) {
          const d = below.getBoundingClientRect().top - h.bottom;
          if (d >= -1 && d < min - 0.5) out.push(`${d}px below "${name(hint)}"`);
        }
      }
      return out;
    }, gap);
    tight.push(...found.map((f) => `${t}: ${f}`));
  }
  expect(tight).toEqual([]);
});

/*
 * Ring rule (DESIGN.md): an outline, ring, border or highlight box keeps `--ring-pad` (8px)
 * between itself and its content, and two outlined siblings sit at least `--ring-gap` (6px)
 * apart. Checked on every Settings tab, with rows changed from the default so their rings show.
 */
test('outlined boxes keep ring padding and never touch each other', async ({ page }) => {
  await openPrefs(page);
  const tokens = await page.locator('.pr-app').evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.getPropertyValue('--ring-pad'), cs.getPropertyValue('--ring-gap')].map((v) =>
      parseFloat(v),
    );
  });
  expect(tokens).toEqual([8, 6]);
  const found: string[] = [];
  for (const t of TABS) {
    await tab(page, t);
    if (t === 'Sounds') {
      // Every row changes at once: stacked rings must not touch.
      await page.getByRole('button', { name: 'Use Lab Glass for every event' }).click();
      await expect(page.locator('.mixrow[data-changed]').nth(1)).toBeVisible();
    }
    found.push(...(await ringFindings(page, '.prefs__main')).map((f) => `${t}: ${f}`));
  }
  expect(found).toEqual([]);
});
