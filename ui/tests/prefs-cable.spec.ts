import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { HARNESS, openPrefs, root } from './prefs-helpers';

const p3 = JSON.parse(
  readFileSync(new URL('./fixtures/prefs-p3-stored.json', import.meta.url), 'utf8'),
) as { themeId: string; customThemes: { id: string; modes: { light: Record<string, string> } }[] };

const PRESETS = ['theme', 'jade', 'signal', 'studio', 'ocean', 'copper'];

const cssVar = (page: Page, name: string) =>
  root(page).evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);

test('Preferences lists the cable presets with names and live previews', async ({ page }) => {
  await openPrefs(page);
  const group = page.getByTestId('cable-presets');
  await expect(group).toBeVisible();
  for (const id of PRESETS) {
    const card = group.locator(`[data-cable-preset="${id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('cable-swatch')).toBeVisible();
  }
  for (const name of ['Jade', 'Signal', 'Studio', 'Ocean', 'Copper']) {
    await expect(group.getByText(name, { exact: true })).toBeVisible();
  }
  // Each swatch previews its own pair; no two presets look alike.
  const pairs = await group
    .getByTestId('cable-swatch')
    .evaluateAll((els) =>
      els.map((e) => `${e.getAttribute('data-cable')}/${e.getAttribute('data-plug')}`),
    );
  expect(new Set(pairs.slice(1)).size).toBe(PRESETS.length - 1);
  // Default is the theme's own pair.
  await expect(group.locator('[data-cable-preset="theme"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('choosing a preset changes only cable and plug, live, and persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(HARNESS);
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  expect(await cssVar(page, '--cable')).toBe('#f2c35b');
  expect(await cssVar(page, '--plug')).toBe('#c7cdd0');

  const tokens = ['--side-bg', '--panel', '--accent', '--bg', '--hole', '--nut', '--c-yellow'];
  const before = await Promise.all(tokens.map((t) => cssVar(page, t)));

  await page.locator('[data-cable-preset="copper"]').click();
  await expect(page.locator('[data-cable-preset="copper"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await cssVar(page, '--cable')).toBe('#d9692a');
  expect(await cssVar(page, '--plug')).toBe('#c9a24a');
  expect(await Promise.all(tokens.map((t) => cssVar(page, t)))).toEqual(before);

  await page.reload();
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  expect(await cssVar(page, '--cable')).toBe('#d9692a');
  await expect(page.locator('[data-cable-preset="copper"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Back to the theme's own pair.
  await page.locator('[data-cable-preset="theme"]').click();
  expect(await cssVar(page, '--cable')).toBe('#f2c35b');
});

test('a preset survives a theme change and a mode change', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPrefs(page);
  await page.locator('[data-cable-preset="ocean"]').click();
  await page.locator('[data-theme-card="cool-paper"]').click();
  await expect(root(page)).toHaveAttribute('data-theme', 'cool-paper');
  expect(await cssVar(page, '--cable')).toBe('#4a9be0');
  await page.getByRole('radio', { name: 'Dark' }).check({ force: true });
  expect(await cssVar(page, '--cable')).toBe('#4a9be0');
  expect(await cssVar(page, '--plug')).toBe('#c7cdd0');
});

test('every preset applies in both modes', async ({ page }) => {
  await openPrefs(page);
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('radio', { name: mode }).check({ force: true });
    for (const id of PRESETS.slice(1)) {
      await page.locator(`[data-cable-preset="${id}"]`).click();
      const sw = page.locator(`[data-cable-preset="${id}"]`).getByTestId('cable-swatch');
      expect(await cssVar(page, '--cable')).toBe(await sw.getAttribute('data-cable'));
      expect(await cssVar(page, '--plug')).toBe(await sw.getAttribute('data-plug'));
    }
  }
});

test('P3-era stored prefs and a custom theme without cable and plug load unchanged', async ({
  page,
}) => {
  await page.addInitScript((stored) => {
    localStorage.setItem('pr.prefs.harness', JSON.stringify(stored));
  }, p3);
  await page.goto(HARNESS);
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();

  // The stored choice stands: the old custom theme is active, in light.
  await expect(root(page)).toHaveAttribute('data-theme', p3.themeId);
  await expect(root(page)).toHaveAttribute('data-mode', 'light');
  await expect(page.locator(`[data-theme-card="${p3.themeId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const old = p3.customThemes[0].modes.light;
  expect(await cssVar(page, '--side-bg')).toBe(old['side-bg']);
  expect(await cssVar(page, '--accent')).toBe(old.accent);
  // Missing tokens are filled from the theme's own yellow and nut, not rejected.
  expect(await cssVar(page, '--cable')).toBe(old['c-yellow']);
  expect(await cssVar(page, '--plug')).toMatch(/^#[0-9a-f]{6}$/);
  // Prefs without a cable preset follow the theme.
  await expect(page.locator('[data-cable-preset="theme"]')).toHaveAttribute('aria-pressed', 'true');
  // Other stored prefs are intact.
  const prefs = await page.evaluate(() => window.__PR_PREFS__.store.getPrefs());
  expect(prefs.searchAllSessions).toBe(true);
  expect(prefs.sound.volume).toBe(0.4);
  expect(prefs.customThemes).toHaveLength(1);
});
