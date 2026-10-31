import { expect, test, type Page } from '@playwright/test';
import { chooseNew, openChat, seedChat } from './helpers';

/** Auto-scroll per log: a visible on/paused indicator, scroll up pauses, bottom or Jump resumes. */

const pill = (page: Page) => page.getByTestId('autoscroll');
const log = (page: Page) => page.getByTestId('chat-log');

async function scrollTo(page: Page, where: 'top' | 'bottom') {
  await log(page).evaluate((el, w) => {
    el.scrollTop = w === 'top' ? 0 : el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  }, where);
}

async function push(page: Page, id: string, n: number) {
  await page.evaluate(
    ({ sid, n }) =>
      window.__PR_MOCK__!.pushItems(sid, [
        { key: `new-${n}`, ts: Date.now(), kind: 'assistant', text: `New reply ${n}` },
      ]),
    { sid: id, n },
  );
}

const atBottom = (page: Page) =>
  log(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 24);

test.describe('auto-scroll', () => {
  test('starts on, scrolling up pauses, scrolling to the bottom resumes', async ({ page }) => {
    const id = await openChat(page);
    await expect(pill(page)).toHaveAttribute('data-state', 'on');
    await expect(pill(page)).toHaveText('Auto-scroll on');
    await scrollTo(page, 'top');
    await expect(pill(page)).toHaveAttribute('data-state', 'paused');
    await expect(pill(page)).toHaveText('Paused');
    // New rows do not move a paused log.
    await push(page, id, 1);
    await expect.poll(() => log(page).evaluate((el) => el.scrollTop)).toBeLessThan(5);
    await scrollTo(page, 'bottom');
    await expect(pill(page)).toHaveAttribute('data-state', 'on');
    await push(page, id, 2);
    await expect.poll(() => atBottom(page)).toBe(true);
  });

  test('Jump to latest turns it back on', async ({ page }) => {
    await openChat(page);
    await scrollTo(page, 'top');
    await page.getByTestId('jump-latest').click();
    await expect(pill(page)).toHaveAttribute('data-state', 'on');
    await expect.poll(() => atBottom(page)).toBe(true);
  });

  test('the indicator is a toggle: pause at the bottom holds until you scroll', async ({
    page,
  }) => {
    const id = await openChat(page);
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute('data-state', 'paused');
    await expect(pill(page)).toHaveAttribute('aria-pressed', 'false');
    const top0 = await log(page).evaluate((el) => el.scrollTop);
    await push(page, id, 3);
    await page.waitForTimeout(200);
    expect(await log(page).evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(top0 + 2);
    await expect(pill(page)).toHaveAttribute('data-state', 'paused');
    // Toggle again: back on, at the newest row.
    await pill(page).click();
    await expect(pill(page)).toHaveAttribute('data-state', 'on');
    await expect.poll(() => atBottom(page)).toBe(true);
  });

  test('the first pause shows a one-time hint that opens the setting', async ({ page }) => {
    await openChat(page);
    await scrollTo(page, 'top');
    const hint = page.locator('[data-hint="scroll.paused"]');
    await expect(hint).toBeVisible();
    await hint.getByRole('button', { name: 'Chat settings' }).click();
    await expect(page.getByTestId('chat-autoscroll')).toBeVisible();
    await page.keyboard.press('Escape');
    await scrollTo(page, 'bottom');
    await scrollTo(page, 'top');
    await expect(page.locator('[data-hint="scroll.paused"]')).toHaveCount(0);
  });

  test('Settings off: logs open paused', async ({ page }) => {
    await page.goto('/?mock&grid=100x30');
    await page.waitForFunction(() => !!window.__PR_STORE__?.getSnapshot().prefs);
    await page.evaluate(() => window.__PR_STORE__!.setPrefs({ chat: { autoScroll: false } }));
    await chooseNew(page, 'New session');
    const dlg = page.getByRole('dialog', { name: 'New session' });
    await dlg.getByLabel('Folder').fill('/tmp/patchroom-test');
    await dlg.getByRole('button', { name: 'Start session' }).click();
    await page.getByTestId('chat').waitFor();
    const id = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0].id);
    await seedChat(page, id);
    await expect(pill(page)).toHaveAttribute('data-state', 'paused');
    // New rows do not pull a paused log down.
    const top0 = await log(page).evaluate((el) => el.scrollTop);
    await push(page, id, 9);
    await page.waitForTimeout(200);
    expect(await log(page).evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(top0 + 2);
  });
});
