import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

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
