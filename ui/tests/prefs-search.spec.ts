import { expect, test, type Page } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';
import { expectNoOverlap, ringFindings } from './qa';
import { SECTIONS, SETTINGS } from '../src/components/prefs/registry';

/*
 * Settings search (registry: ui/src/components/prefs/registry.ts). The field tops the
 * Settings sidebar, Cmd+F focuses it, results list section > setting, and choosing one opens
 * the section at that row and flashes it. Esc clears, then closes.
 */

const field = (page: Page) => page.getByTestId('prefs-search');
const results = (page: Page) => page.getByTestId('prefs-results').locator('.pres');

test('every rendered setting row has a registry entry, and every entry a row', async ({ page }) => {
  // Seed state so conditional rows render: bundles (Where bundles apply), a schedule.
  await openPrefs(page);
  await page.evaluate(() =>
    window.__PR_PREFS__.store.update({
      dnd: { manual: false, schedule: { days: [1], start: '22:00', end: '07:00' } },
      models: {
        bundles: [
          {
            id: 'daily',
            name: 'Daily',
            entries: [{ id: 'a', tool: 'claude-code', model: 'claude-opus-5-5' }],
            defaultEntry: 'a',
          },
        ],
        defaultBundle: 'daily',
        perFolder: {},
        perSection: {},
        perSession: {},
        labels: {},
        groupLabels: { cloud: '{name}', local: '{name}' },
        seen: [],
        offered: [],
      },
    }),
  );
  const known = new Set(SETTINGS.map((s) => s.id));
  const missing: string[] = [];
  const rendered = new Set<string>();
  for (const s of SECTIONS) {
    await tab(page, s.label);
    await expect(page.locator('.prefs__main .pf-section')).toBeVisible();
    const found = await page.locator('.prefs__main').evaluate((main) => {
      const shown = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      // A setting row: a group heading, a labeled field, or a switch. Each must sit in (or, for
      // a heading, right above) an element tagged with its registry id.
      const rows = [
        ...main.querySelectorAll('h3, legend:not(.sr-only), label.chk, label.pf'),
      ].filter(shown);
      const bare: string[] = [];
      for (const r of rows) {
        const own = r.closest('[data-setting]');
        const next = r.matches('h3, legend') ? r.nextElementSibling : null;
        if (!own && !next?.matches('[data-setting]'))
          bare.push(`${r.tagName.toLowerCase()} "${(r.textContent ?? '').trim().slice(0, 40)}"`);
      }
      const ids = [...main.querySelectorAll('[data-setting]')].map(
        (e) => e.getAttribute('data-setting') ?? '',
      );
      return { bare, ids };
    });
    missing.push(...found.bare.map((b) => `${s.label}: ${b} has no data-setting`));
    for (const id of found.ids) {
      rendered.add(id);
      if (!known.has(id)) missing.push(`${s.label}: data-setting="${id}" is not in the registry`);
      else if (SETTINGS.find((x) => x.id === id)!.section !== s.id)
        missing.push(`${s.label}: "${id}" is registered under another section`);
    }
  }
  for (const s of SETTINGS)
    if (!s.conditional && !rendered.has(s.id))
      missing.push(`registry entry "${s.id}" renders no row`);
  expect(missing).toEqual([]);
});

test('search finds fonts and updates, and nothing for noreply', async ({ page }) => {
  await openPrefs(page);
  await field(page).fill('font');
  await expect(results(page).first()).toContainText('Fonts');
  await expect(results(page).first().locator('.pres__sec')).toHaveText('Themes');

  await field(page).fill('update');
  await expect(results(page).first()).toContainText('Updates');
  await expect(results(page).filter({ hasText: 'Check for app updates' })).toHaveCount(1);

  await field(page).fill('noreply');
  await expect(results(page)).toHaveCount(0);
  await expect(page.getByTestId('prefs-no-results')).toHaveText('No settings match “noreply”');
});

test('a description and a keyword match too', async ({ page }) => {
  await openPrefs(page);
  await field(page).fill('monospace');
  await expect(results(page).first()).toContainText('Code and terminal font');
  await field(page).fill('quiet hours');
  await expect(results(page).first()).toContainText('Do Not Disturb schedule');
});

test('choosing a result opens the section, scrolls to the row and flashes it', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 640 });
  await openPrefs(page);
  await tab(page, 'Links');
  await field(page).fill('code terminal font');
  await results(page).first().click();
  const row = page.locator('[data-setting="themes.fonts.code"]');
  await expect(row).toHaveAttribute('data-flash', 'true');
  await expect(row).toBeInViewport();
  const ring = page.getByTestId('pf-flash');
  await expect(ring).toBeVisible();
  // The ring sits one --ring-pad outside the row and does not move it.
  const [r, f] = await Promise.all([row.boundingBox(), ring.boundingBox()]);
  expect(Math.round(r!.x - f!.x)).toBe(8);
  expect(Math.round(r!.y - f!.y)).toBe(8);
  expect(await ringFindings(page, '.prefs__main')).toEqual([]);
  await expectNoOverlap(page);
  await expect(row).not.toHaveAttribute('data-flash', 'true', { timeout: 4000 });
  await expect(ring).toHaveCount(0);
});

test('Enter picks the first result and arrows walk the list', async ({ page }) => {
  await openPrefs(page);
  await field(page).fill('pin artifacts');
  await field(page).press('Enter');
  await expect(page.getByTestId('prefs-links')).toBeVisible();
  await field(page).fill('sound');
  await field(page).press('ArrowDown');
  await expect(results(page).first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(results(page).nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(field(page)).toBeFocused();
});

test('Cmd+F focuses the field; Esc clears, then closes', async ({ page }) => {
  await openPrefs(page);
  const dlg = page.getByRole('dialog', { name: 'Settings' });
  await tab(page, 'Sounds');
  await page.locator('.prefs__main h2').click();
  await page.keyboard.press('Meta+f');
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('volume');
  await expect(results(page).first()).toContainText('Play sounds');
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveValue('');
  await expect(dlg).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('search results never overlap or clip, light and dark', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 880, height: 600 });
    await openPrefs(page);
    await field(page).fill('sound');
    await expect(results(page).first()).toBeVisible();
    await expectNoOverlap(page);
    expect(await ringFindings(page, '.prefs__side')).toEqual([]);
    await field(page).fill('zzz');
    await expect(page.getByTestId('prefs-no-results')).toBeVisible();
    await expectNoOverlap(page);
  }
});
