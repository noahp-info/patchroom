import { expect, test, type Page } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

/*
 * Theme import (SPEC 3.5, onboarding step 4): Settings > Themes and > Terminal list the looks
 * of installed tools (mock fixture: iTerm2, Ghostty, Terminal with one skipped profile), show a
 * preview, apply, and undo once. The backend only reads; the mock never touches real files.
 */

const prefs = (page: Page) => page.evaluate(() => window.__PR_PREFS__.store.getPrefs());

async function openImport(page: Page, target: 'theme' | 'terminal') {
  const box = page.getByTestId(`import-from-${target}`);
  await box.getByRole('button', { name: 'Import from…' }).click();
  await expect(box.getByTestId('import-preview')).toBeVisible();
  return box;
}

test('Themes: the list holds only installed tools, previews, applies an AA theme, and undoes', async ({
  page,
}) => {
  await openPrefs(page);
  const before = await prefs(page);
  const box = await openImport(page, 'theme');
  const look = box.getByLabel('Look');
  // Grouped by tool; Terminal has no readable looks, so it has no group.
  await expect(look.locator('optgroup')).toHaveCount(2);
  await expect(look.locator('optgroup[label="iTerm2"] option')).toHaveText(['Tokyo Night']);
  await expect(box.getByTestId('import-swatches').locator('i')).toHaveCount(18);
  await expect(box.getByTestId('theme-preview')).toHaveAttribute('data-mode', 'dark');
  await expect(box.locator('.imp__skipped summary')).toHaveText('2 looks could not be read');

  // A light look previews in light.
  await look.selectOption({ label: 'Current config' });
  await expect(box.getByTestId('theme-preview')).toHaveAttribute('data-mode', 'light');
  await look.selectOption({ label: 'Tokyo Night' });

  await box.getByTestId('import-apply').click();
  await expect(box.getByTestId('import-done')).toContainText('Applied Tokyo Night.');
  const after = await prefs(page);
  expect(after.customThemes).toHaveLength(before.customThemes.length + 1);
  const made = after.customThemes.at(-1)!;
  expect(after.themeId).toBe(made.id);
  expect(made.modes.dark.bg).toBe('#1a1b26');
  // The derived theme meets WCAG AA in both modes.
  const errors = await page.evaluate(async (t) => {
    const { validateTheme } = await import('/src/theme/validate.ts');
    const r = validateTheme(t, { requireAA: true });
    return r.ok ? [] : r.errors;
  }, made);
  expect(errors).toEqual([]);
  await expect(page.locator(`[data-theme-card="${made.id}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await box.getByTestId('import-undo').click();
  await expect(box.getByTestId('import-done')).toHaveCount(0);
  const undone = await prefs(page);
  expect(undone.themeId).toBe(before.themeId);
  expect(undone.customThemes).toEqual(before.customThemes);
});

test('Terminal: applies the exact palette, font and size to every session, and undoes', async ({
  page,
}) => {
  await openPrefs(page);
  await tab(page, 'Terminal');
  const before = await prefs(page);
  const box = await openImport(page, 'terminal');
  await expect(box.getByTestId('import-preview').getByTestId('term-preview')).toHaveCSS(
    'background-color',
    'rgb(26, 27, 38)',
  );
  await box.getByTestId('import-apply').click();
  await expect(box.getByTestId('import-done')).toContainText('Applied Tokyo Night.');

  const after = await prefs(page);
  expect(after.termPalettes).toHaveLength(1);
  const def = after.termPerDm['*'];
  expect(def.themeId).toBe(`import:${after.termPalettes[0].id}`);
  expect(def.font).toBe('JetBrains Mono');
  expect(def.fontSize).toBe(14);
  // The default row picks it up, and a live terminal restyles with the exact colors.
  const row = page.getByTestId('term-row-default');
  await expect(row.getByLabel('All sessions palette')).toHaveValue(def.themeId!);
  await expect(row.getByLabel('All sessions font size')).toHaveValue('14');
  await expect
    .poll(() => page.evaluate(() => window.__PR_PREFS__.fakeTerm.options.theme?.background))
    .toBe('#1a1b26');
  const ansi = await page.evaluate(() => window.__PR_PREFS__.fakeTerm.options.theme?.brightBlack);
  expect(ansi).toBe('#414868');

  await box.getByTestId('import-undo').click();
  const undone = await prefs(page);
  expect(undone.termPalettes).toEqual(before.termPalettes);
  expect(undone.termPerDm).toEqual(before.termPerDm);
});

test('Terminal: a picked .itermcolors file previews and applies; an unknown font stays listed', async ({
  page,
}) => {
  await openPrefs(page);
  await tab(page, 'Terminal');
  const box = await openImport(page, 'terminal');
  await box.getByRole('button', { name: 'Choose an .itermcolors file…' }).click();
  await expect(box.locator('.imp__meta')).toHaveText('Solarized Dark from a file');
  await box.getByTestId('import-apply').click();
  const after = await prefs(page);
  expect(after.termPalettes[0].name).toBe('Solarized Dark');
  expect(after.termPerDm['*'].font).toBeUndefined();

  // A font from another tool that is not in the built-in list still shows as the value.
  await page.evaluate(() =>
    window.__PR_PREFS__.store.update({ termPerDm: { '*': { font: 'Andale Mono', fontSize: 17 } } }),
  );
  const row = page.getByTestId('term-row-default');
  await expect(row.getByLabel('All sessions font', { exact: true })).toHaveValue('Andale Mono');
  await expect(row.getByLabel('All sessions font size')).toHaveValue('17');
});
