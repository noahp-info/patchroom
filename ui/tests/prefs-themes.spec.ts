import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { HARNESS, openPrefs, root } from './prefs-helpers';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/prefs-slack-themes.json', import.meta.url), 'utf8'),
) as {
  themes: { name: string; string: string }[];
  bad: string[];
};

const sideBg = (page: import('@playwright/test').Page) =>
  root(page).evaluate((el) => getComputedStyle(el).getPropertyValue('--side-bg').trim());

test('picker shows the four shipped themes as live previews', async ({ page }) => {
  await openPrefs(page);
  for (const id of ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper']) {
    const card = page.locator(`[data-theme-card="${id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('theme-preview')).toHaveAttribute('data-theme-id', id);
  }
  await expect(page.locator('[data-theme-card="homeroom"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('picking a theme restyles the whole app and open terminals', async ({ page }) => {
  await openPrefs(page);
  const before = await sideBg(page);
  const termBefore = await page.evaluate(
    () => window.__PR_PREFS__.fakeTerm.options.theme?.background,
  );
  await page.locator('[data-theme-card="cool-paper"]').click();
  await expect(root(page)).toHaveAttribute('data-theme', 'cool-paper');
  expect(await sideBg(page)).not.toBe(before);
  await expect(page.locator('[data-theme-card="cool-paper"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const termAfter = await page.evaluate(
    () => window.__PR_PREFS__.fakeTerm.options.theme?.background,
  );
  expect(termAfter).not.toBe(termBefore);
});

test('light, dark and system switch the mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPrefs(page);
  await expect(root(page)).toHaveAttribute('data-mode', 'light');
  await page.getByRole('radio', { name: 'Dark' }).check({ force: true });
  await expect(root(page)).toHaveAttribute('data-mode', 'dark');
  await page.getByRole('radio', { name: 'System' }).check({ force: true });
  await expect(root(page)).toHaveAttribute('data-mode', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root(page)).toHaveAttribute('data-mode', 'dark');
});

test('the theme choice persists across a reload', async ({ page }) => {
  await page.goto(HARNESS);
  await page.getByRole('dialog', { name: 'Settings' }).waitFor();
  await page.locator('[data-theme-card="patch-bay"]').click();
  await page.getByRole('radio', { name: 'Dark' }).check({ force: true });
  await page.reload();
  await expect(root(page)).toHaveAttribute('data-theme', 'patch-bay');
  await expect(root(page)).toHaveAttribute('data-mode', 'dark');
});

test('custom editor rejects an AA failure and names the pair', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPrefs(page);
  await page.getByRole('button', { name: 'New custom theme' }).click();
  const ed = page.getByTestId('custom-editor');
  await expect(ed.getByTestId('aa-status')).toContainText('meet WCAG AA');
  const bg = await ed.getByLabel('light bg', { exact: true }).inputValue();
  await ed.getByLabel('light muted', { exact: true }).fill(bg);
  const fails = ed.getByTestId('aa-failures');
  await expect(fails).toContainText('muted');
  await expect(fails).toContainText('on bg');
  await expect(fails).toContainText('secondary text');
  await expect(ed.getByRole('button', { name: 'Save theme' })).toBeDisabled();
  // The preview and the failing field are flagged.
  await expect(ed.getByLabel('light muted', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );

  // Repair fixes the text colors and saving becomes possible.
  await ed.getByRole('button', { name: 'Repair text colors' }).click();
  await expect(ed.getByTestId('aa-status')).toContainText('meet WCAG AA');
  await ed.getByLabel('Theme name').fill('Quiet Room');
  await ed.getByRole('button', { name: 'Save theme' }).click();
  const card = page.locator('[data-theme-card="custom-quiet-room"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(root(page)).toHaveAttribute('data-theme', 'custom-quiet-room');
});

test('custom editor flags a token that is not a color', async ({ page }) => {
  await openPrefs(page);
  await page.getByRole('button', { name: 'New custom theme' }).click();
  const ed = page.getByTestId('custom-editor');
  await ed.getByLabel(/^(light|dark) fg$/).fill('banana');
  await expect(ed.getByTestId('aa-status')).toContainText('Not a color');
  await expect(ed.getByRole('button', { name: 'Save theme' })).toBeDisabled();
});

for (const t of fixture.themes) {
  test(`a real Slack theme string imports: ${t.name}`, async ({ page }) => {
    await openPrefs(page);
    await page.getByLabel('Slack theme string').fill(t.string);
    await page.getByLabel('Name', { exact: true }).fill(t.name);
    await page.getByRole('button', { name: 'Import theme' }).click();
    await expect(page.getByTestId('slack-msg')).toContainText(`Imported "${t.name}"`);
    const id = `slack-${t.name.toLowerCase()}`;
    await expect(page.locator(`[data-theme-card="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(root(page)).toHaveAttribute('data-theme', id);
    // The sidebar color is the string's first color.
    const want = t.string.split(',')[0].toLowerCase();
    expect(await sideBg(page)).toBe(want);
  });
}

test('a bad Slack string is refused with a reason', async ({ page }) => {
  await openPrefs(page);
  for (const bad of fixture.bad) {
    await page.getByLabel('Slack theme string').fill(bad);
    await page.getByRole('button', { name: 'Import theme' }).click();
    await expect(page.getByTestId('slack-msg')).toBeVisible();
    await expect(page.getByTestId('slack-msg')).not.toContainText('Imported');
  }
  await expect(page.locator('[data-theme-card^="slack-"]')).toHaveCount(0);
});

test('Homeroom is the jade default: band, panel and workspace mark come from the mark', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openPrefs(page);
  await expect(root(page)).toHaveAttribute('data-theme', 'homeroom');
  const v = (n: string) =>
    root(page).evaluate((el, k) => getComputedStyle(el).getPropertyValue(k).trim(), n);
  expect(await v('--side-bg')).toBe('#135a4b');
  expect(await v('--panel')).toBe('#135a4b');
  expect(await v('--ws-mark')).toBe('#f7f3e8');
  expect(await v('--side-active')).toBe('#f2c35b');
  expect(await v('--accent')).not.toBe('#135a4b');
});
