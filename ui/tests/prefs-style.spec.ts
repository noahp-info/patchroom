import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openWithDm } from './helpers';

const p3 = JSON.parse(
  readFileSync(new URL('./fixtures/prefs-p3-stored.json', import.meta.url), 'utf8'),
) as { themeId: string };

const APP = 'mock&persist&grid=100x30';

const app = (page: Page) => page.locator('.pr-app');
const cssVar = (page: Page, name: string) =>
  app(page).evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);
const COLOR_TOKENS = ['--side-bg', '--panel', '--accent', '--bg', '--hole', '--nut', '--c-yellow'];
const colors = (page: Page) => Promise.all(COLOR_TOKENS.map((t) => cssVar(page, t)));

async function openThemes(page: Page): Promise<void> {
  await page.keyboard.press('Meta+,');
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  await page
    .getByRole('navigation', { name: 'Preferences sections' })
    .getByRole('button', { name: 'Themes', exact: true })
    .click();
  await page.getByTestId('style-picker').waitFor();
}

const cableStroke = (page: Page) =>
  page
    .locator('.pr-app > svg.cable path')
    .nth(1)
    .evaluate((p) => getComputedStyle(p).stroke);
const plugStroke = (page: Page) =>
  page
    .locator('.pr-app > svg.cable circle')
    .first()
    .evaluate((c) => getComputedStyle(c).stroke);

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

test('Style defaults to Homeroom and switching to Patch Bay restyles the app live', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openWithDm(page, APP, 'chat');
  await expect(app(page)).toHaveAttribute('data-base', 'homeroom');
  await expect(page.locator('.pr-app > svg.cable')).toBeHidden();
  const jack = page.locator('.row.active .jack');
  await expect(jack).toBeHidden();

  await openThemes(page);
  const picker = page.getByTestId('style-picker');
  await expect(picker.getByRole('radio', { name: 'Homeroom' })).toBeChecked();
  const before = await colors(page);
  await picker.getByRole('radio', { name: 'Patch Bay' }).check({ force: true });

  await expect(app(page)).toHaveAttribute('data-base', 'patchbay');
  await expect(jack).toBeVisible();
  await expect(page.locator('.pr-app > svg.cable')).toBeVisible();
  // The base changes layout, never the palette.
  expect(await colors(page)).toEqual(before);
  expect(await app(page).getAttribute('data-theme')).toBe('homeroom');

  await picker.getByRole('radio', { name: 'Homeroom' }).check({ force: true });
  await expect(app(page)).toHaveAttribute('data-base', 'homeroom');
  await expect(page.locator('.pr-app > svg.cable')).toBeHidden();
});

test('the jade default drives the real Patch Bay cable and plugs', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openWithDm(page, APP, 'chat');
  await openThemes(page);
  await page.getByTestId('style-picker').getByRole('radio', { name: 'Patch Bay' }).check({
    force: true,
  });
  await expect(page.locator('.pr-app > svg.cable')).toBeVisible();
  expect(await cableStroke(page)).toBe(rgb('#f2c35b'));
  expect(await plugStroke(page)).toBe(rgb('#c7cdd0'));
  // The cable is routed between two real jacks.
  const d = await page.locator('.pr-app > svg.cable path').nth(1).getAttribute('d');
  expect(d).toMatch(/^M[\d.]+ [\d.]+ C /);
});

test('a preset changes only cable and plug on the real Patch Bay chrome', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openWithDm(page, APP, 'chat');
  await openThemes(page);
  await page.getByTestId('style-picker').getByRole('radio', { name: 'Patch Bay' }).check({
    force: true,
  });
  const before = await colors(page);
  await page.locator('[data-cable-preset="copper"]').click();
  await expect(page.locator('[data-cable-preset="copper"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await cableStroke(page)).toBe(rgb('#d9692a'));
  expect(await plugStroke(page)).toBe(rgb('#c9a24a'));
  expect(await cssVar(page, '--cable')).toBe('#d9692a');
  expect(await cssVar(page, '--plug')).toBe('#c9a24a');
  expect(await colors(page)).toEqual(before);
  await expect(app(page)).toHaveAttribute('data-base', 'patchbay');
  await expect(app(page)).toHaveAttribute('data-theme', 'homeroom');
});

test('style and preset survive a reload through the persisted mock prefs', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openWithDm(page, APP, 'chat');
  await openThemes(page);
  await page.getByTestId('style-picker').getByRole('radio', { name: 'Patch Bay' }).check({
    force: true,
  });
  await page.locator('[data-cable-preset="ocean"]').click();
  await expect(app(page)).toHaveAttribute('data-base', 'patchbay');

  await page.reload();
  await expect(app(page)).toHaveAttribute('data-base', 'patchbay');
  expect(await cssVar(page, '--cable')).toBe('#4a9be0');
  const prefs = await page.evaluate(() => window.__PR_MOCK__!.prefs());
  expect(prefs.base).toBe('patchbay');
  expect(prefs.cablePreset).toBe('ocean');
  // The choices live in the prefs store, not in loose localStorage keys.
  const loose = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => /cable|preset/i.test(k)),
  );
  expect(loose).toEqual([]);

  await openThemes(page);
  await expect(
    page.getByTestId('style-picker').getByRole('radio', { name: 'Patch Bay' }),
  ).toBeChecked();
  await expect(page.locator('[data-cable-preset="ocean"]')).toHaveAttribute('aria-pressed', 'true');
});

test('P3-era prefs without base or cablePreset load with the defaults', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript((stored) => {
    // A mock snapshot written before `base` and `cablePreset` existed.
    const old = { ...(stored as Record<string, unknown>) };
    delete old.base;
    delete old.cablePreset;
    localStorage.setItem(
      'patchroom.mock.state',
      JSON.stringify({
        counter: 0,
        sessions: [],
        sections: [],
        chats: [],
        badges: [],
        drafts: [],
        marks: [],
        prefs: old,
      }),
    );
  }, p3);
  await page.goto(`/?${APP}`);
  await expect(app(page)).toHaveAttribute('data-theme', p3.themeId);
  await expect(app(page)).toHaveAttribute('data-base', 'homeroom');
  const prefs = await page.evaluate(() => window.__PR_MOCK__!.prefs());
  expect(prefs.base).toBe('homeroom');
  expect(prefs.cablePreset).toBe('theme');
  expect(prefs.customThemes).toHaveLength(1);
});
