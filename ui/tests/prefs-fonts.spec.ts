import { expect, test, type Page } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';
import { expectNoOverlap, ringFindings } from './qa';
import { openChat } from './helpers';

/*
 * Settings > Themes > Fonts (ui/src/theme/typeface.ts). Each area takes a family and a size
 * through CSS variables on the root; unset areas inherit; the picker previews each family in
 * its own face; code lists fixed-pitch families only; the terminal follows live.
 */

const prefs = (page: Page) => page.evaluate(() => window.__PR_PREFS__.store.getPrefs());
const rootVar = (page: Page, name: string) =>
  page.locator('.pr-app').evaluate((el, n) => el.style.getPropertyValue(n), name);

async function pick(page: Page, area: string, family: string) {
  await page.getByTestId(`font-family-${area}`).click();
  const list = page.getByRole('listbox', { name: new RegExp(`font$`) });
  await list.getByRole('option', { name: family, exact: true }).click();
}

test('each family previews in its own face; code offers fixed-pitch fonts only', async ({
  page,
}) => {
  await openPrefs(page);
  await page.getByTestId('font-family-ui').click();
  const list = page.getByRole('listbox', { name: 'UI font' });
  await expect(list.getByRole('option', { name: 'Georgia', exact: true })).toHaveCSS(
    'font-family',
    /^"?Georgia"?,/,
  );
  // Bundled faces first, then the installed ones; the default names what it inherits.
  await expect(list.getByRole('option').first()).toHaveText('Default (Figtree)');
  await expect(list.getByRole('group', { name: 'Bundled with Patchroom' })).toBeVisible();
  await expect(list.getByRole('group', { name: 'On this Mac' })).toBeVisible();
  await expect(page.locator('.floating.flist')).toBeInViewport({ ratio: 1 });
  expect(await ringFindings(page, '.floating.flist')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();

  await page.getByTestId('font-family-code').click();
  const code = page.getByRole('listbox', { name: 'Code and terminal font' });
  await expect(code.getByRole('option', { name: 'Menlo', exact: true })).toBeVisible();
  await expect(code.getByRole('option', { name: 'Georgia', exact: true })).toHaveCount(0);
  await expect(code.getByRole('option', { name: 'Figtree', exact: true })).toHaveCount(0);
  // Typing filters and the first match is active; arrows move, Enter picks.
  await page.keyboard.type('mon');
  await expect(code.getByRole('option')).toHaveText([
    'JetBrains Mono',
    'Red Hat Mono',
    'Monaco',
    'SF Mono',
  ]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prefs(page)).fonts?.code?.family).toBe('Monaco');
});

test('areas set variables, unset ones inherit, and Reset clears', async ({ page }) => {
  await openPrefs(page);
  await pick(page, 'ui', 'Georgia');
  expect(await rootVar(page, '--f-ui')).toContain('"Georgia"');
  // Chat inherits the UI family until it has its own; the button says so.
  await expect(page.getByTestId('font-family-chat')).toContainText('Georgia');
  await expect(page.getByTestId('font-family-chat')).toContainText('from UI');
  await pick(page, 'chat', 'Verdana');
  expect(await rootVar(page, '--f-chat')).toContain('"Verdana"');
  await page.getByTestId('font-size-chat').selectOption('16');
  expect(Number(await rootVar(page, '--fz-chat'))).toBeCloseTo(16 / 13, 2);
  // The UI size scales every area without its own size.
  await page.getByTestId('font-size-ui').selectOption('15');
  await expect(page.getByTestId('font-size-sidebar').locator('option').first()).toHaveText(
    /^15 px, from UI/,
  );
  const h2 = await page
    .locator('.prefs__main h2')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(h2).toBeCloseTo(15, 0);

  await page.getByRole('button', { name: 'Reset Chat messages font' }).click();
  expect((await prefs(page)).fonts?.chat).toBeUndefined();
  expect(await rootVar(page, '--f-chat')).toBe('');
  await page.getByTestId('fonts-reset-all').click();
  expect((await prefs(page)).fonts).toEqual({});
  expect(await rootVar(page, '--f-ui')).toBe('');
  await expect(page.getByTestId('fonts-reset-all')).toBeDisabled();
});

test('the terminal picks up the code family and size live', async ({ page }) => {
  await openPrefs(page);
  await pick(page, 'code', 'SF Mono');
  await page.getByTestId('font-size-code').selectOption('16');
  await expect
    .poll(() => page.evaluate(() => window.__PR_PREFS__.fakeTerm.options.fontFamily))
    .toContain('"SF Mono"');
  expect(await page.evaluate(() => window.__PR_PREFS__.fakeTerm.options.fontSize)).toBe(16);
  // Settings > Terminal shows the same value as its default row.
  await tab(page, 'Terminal');
  const row = page.getByTestId('term-row-default');
  await expect(row.getByLabel('All sessions font', { exact: true })).toHaveValue('SF Mono');
  await row.getByLabel('All sessions font size').selectOption('12');
  expect((await prefs(page)).fonts?.code).toEqual({ family: 'SF Mono', size: 12 });
});

test('the old terminal default font migrates to the code area', async ({ page }) => {
  await openPrefs(page);
  await page.evaluate(() =>
    window.__PR_PREFS__.api.prefsSet({
      termPerDm: { '*': { font: 'Menlo', fontSize: 15, themeId: 'iterm' } },
    }),
  );
  const p = await page.evaluate(() => window.__PR_PREFS__.api.prefsGet());
  expect(p.fonts?.code).toEqual({ family: 'Menlo', size: 15 });
  expect(p.termPerDm['*']).toEqual({ themeId: 'iterm' });
});

test('a theme change never touches the fonts', async ({ page }) => {
  await openPrefs(page);
  await pick(page, 'ui', 'Georgia');
  await page.locator('[data-theme-card="cool-paper"]').click();
  expect((await prefs(page)).fonts?.ui?.family).toBe('Georgia');
  expect(await rootVar(page, '--f-ui')).toContain('"Georgia"');
});

test('the first visit to Themes shows the fonts hint once, and it jumps to Fonts', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 640 });
  await openPrefs(page);
  const hint = page.getByTestId('hint');
  await expect(hint).toHaveAttribute('data-hint', 'fonts.themes');
  await expect(hint).toContainText('font');
  expect((await prefs(page)).hints.seen).toContain('fonts.themes');
  await expectNoOverlap(page);
  await hint.getByRole('button', { name: 'Show fonts' }).click();
  await expect(hint).toHaveCount(0);
  await expect(page.locator('[data-setting="themes.fonts"]')).toHaveAttribute('data-flash', 'true');
  await expect(page.locator('[data-setting="themes.fonts"]')).toBeInViewport();
  // Seen: another visit to Themes shows nothing.
  await tab(page, 'Links');
  await tab(page, 'Themes');
  await expect(page.getByTestId('hint')).toHaveCount(0);
});

test('fonts rows never overlap or clip at the minimum window, light and dark', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 880, height: 600 });
    await openPrefs(page);
    await pick(page, 'statusBar', 'Helvetica Neue');
    await page.getByTestId('font-size-ui').selectOption('18');
    await page.locator('[data-setting="themes.fonts"]').scrollIntoViewIfNeeded();
    await expectNoOverlap(page);
    expect(await ringFindings(page, '.prefs__main')).toEqual([]);
  }
});

test('a section and a session override the chat font from their sidebar menu', async ({ page }) => {
  const id = await openChat(page);
  const body = page.locator('[data-testid="chat"] .logcol').first();
  const family = () => body.evaluate((el) => getComputedStyle(el).fontFamily);
  const size = () =>
    page
      .locator('[data-testid="chat"] .logcol .msg .body')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(await family()).toContain('Figtree');
  const before = await size();

  await page.locator(`.side [data-dm="${id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Chat font...' }).click();
  const pop = page.getByRole('dialog', { name: /^Chat font for / });
  await expect(pop).toBeVisible();
  const fams = pop.getByRole('listbox');
  await expect(fams.getByRole('option').first()).toHaveText(/^Default \(Figtree\)/);
  await fams.getByRole('option', { name: 'Georgia', exact: true }).click();
  await pop.getByTestId('chat-font-size').selectOption('16');
  await expect.poll(family).toContain('Georgia');
  expect(await size()).toBeGreaterThan(before);
  // Only this chat: the sidebar keeps the UI face.
  expect(await page.locator('.side').evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
    'Figtree',
  );
  await expectNoOverlap(page);
  await pop.getByTestId('chat-font-reset').click();
  await expect.poll(family).toContain('Figtree');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
});
