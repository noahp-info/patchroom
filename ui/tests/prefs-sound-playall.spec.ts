import { expect, test, type Page } from '@playwright/test';
import { openPrefs, spyAudio, tab } from './prefs-helpers';

/*
 * "Play the whole mix" walks the eight events 700 ms apart. The row whose sound starts hops
 * (a CSS transform on its label) and lights up; with reduced motion it only lights up.
 */
const row = (page: Page, e: string) => page.getByTestId(`mix-${e}`);
const label = (page: Page, e: string) => row(page, e).locator('.mixrow__label');
const anim = (page: Page, e: string, part: 'row' | 'label') =>
  (part === 'row' ? row(page, e) : label(page, e)).evaluate(
    (el) => getComputedStyle(el).animationName,
  );

test.beforeEach(async ({ page }) => {
  await spyAudio(page);
});

test('each row hops as its sound starts, one at a time, then settles', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  await page.getByRole('button', { name: 'Play the whole mix' }).click();

  await expect(row(page, 'needs')).toHaveAttribute('data-playing', 'true');
  expect(await anim(page, 'needs', 'label')).toBe('mix-hop');
  expect(await anim(page, 'needs', 'row')).toBe('mix-glow');
  await expect(page.locator('.mixrow[data-playing]')).toHaveCount(1);

  await expect(row(page, 'done')).toHaveAttribute('data-playing', 'true');
  await expect(row(page, 'needs')).not.toHaveAttribute('data-playing', /.*/);
  await expect(row(page, 'session')).toHaveAttribute('data-playing', 'true', { timeout: 8000 });
  await expect(page.locator('.mixrow[data-playing]')).toHaveCount(0, { timeout: 3000 });
  // Every event was played, in order.
  const played = await page.evaluate(() =>
    window.__PR_PREFS__.soundLog.map((l) => l.event).slice(-8),
  );
  expect(played).toEqual([
    'needs',
    'done',
    'message',
    'error',
    'bell',
    'decision',
    'due',
    'session',
  ]);
});

test('an Off event is skipped and its row does not hop', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  await page.getByLabel('Turn complete source', { exact: true }).selectOption('off');
  await page.getByRole('button', { name: 'Play the whole mix' }).click();
  await expect(row(page, 'needs')).toHaveAttribute('data-playing', 'true');
  await expect(row(page, 'message')).toHaveAttribute('data-playing', 'true');
  await expect(row(page, 'done')).not.toHaveAttribute('data-playing', /.*/);
});

test('with reduced motion the row lights up and nothing moves', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPrefs(page);
  await tab(page, 'Sounds');
  await page.getByRole('button', { name: 'Play the whole mix' }).click();
  await expect(row(page, 'needs')).toHaveAttribute('data-playing', 'true');
  expect(await anim(page, 'needs', 'label')).toBe('none');
  expect(await anim(page, 'needs', 'row')).toBe('mix-glow');
});
