import { expect, test, type Page } from '@playwright/test';
import { openChat, watchErrors } from './helpers';

// Links open in the in-app viewer or the browser (Links pref), never by navigating the app.

const ts = Date.UTC(2026, 9, 15, 10, 0);
const URL_A = 'https://claude.ai/artifact/CxWsf7LuBBuLJ791ZWKR1T';
const ITEMS = [{ key: 'm1', ts, kind: 'assistant', text: `Published it: ${URL_A}` }];
const mock = <T>(page: Page, fn: () => T) => page.evaluate(fn);
const link = (page: Page) => page.locator('.msg[data-key="m1"] a[href]').first();

test.describe('links', () => {
  test('a click opens the in-app viewer, with Open in browser and close', async ({ page }) => {
    const errs = watchErrors(page);
    await openChat(page, ITEMS);
    await link(page).click();
    const viewer = page.getByTestId('viewer');
    await expect(viewer).toBeVisible();
    await expect(page.getByTestId('viewer-title')).toHaveText('Page at claude.ai');
    expect(await mock(page, () => window.__PR_MOCK__!.viewer[0])).toBe(`show ${URL_A}`);
    // The app itself never navigated.
    expect(page.url()).toContain('mock');
    // The pane sits right of the chat and the chat keeps working.
    const box = await viewer.boundingBox();
    const chat = await page.getByTestId('chat').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(chat!.x + chat!.width - 1);
    await page.getByTestId('viewer-browser').click();
    expect(await mock(page, () => window.__PR_MOCK__!.external)).toEqual([URL_A]);
    await page.getByTestId('viewer-close').click();
    await expect(viewer).toHaveCount(0);
    expect(await mock(page, () => window.__PR_MOCK__!.viewer.at(-1))).toBe('hide');
    expect(errs).toEqual([]);
  });

  test('Cmd-click opens the browser instead', async ({ page }) => {
    await openChat(page, ITEMS);
    await link(page).click({ modifiers: ['Meta'] });
    expect(await mock(page, () => window.__PR_MOCK__!.external)).toEqual([URL_A]);
    await expect(page.getByTestId('viewer')).toHaveCount(0);
  });

  test('with the preference on the browser, a click goes there and Cmd-click comes here', async ({
    page,
  }) => {
    await openChat(page, ITEMS);
    await page.evaluate(() => window.__PR_STORE__!.setPrefs({ links: { open: 'browser' } }));
    await link(page).click();
    expect(await mock(page, () => window.__PR_MOCK__!.external)).toEqual([URL_A]);
    await expect(page.getByTestId('viewer')).toHaveCount(0);
    await link(page).click({ modifiers: ['Meta'] });
    await expect(page.getByTestId('viewer')).toBeVisible();
  });

  test('right-click on a link offers both places and Copy link', async ({ page }) => {
    await openChat(page, ITEMS);
    await link(page).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Link' });
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Open in Patchroom',
      'Open in browser',
      'Copy link',
    ]);
    await menu.getByRole('menuitem', { name: 'Open in browser' }).click();
    expect(await mock(page, () => window.__PR_MOCK__!.external)).toEqual([URL_A]);
  });

  test('the Links preference switches where links open', async ({ page }) => {
    await openChat(page, ITEMS);
    await page.evaluate(() => window.__PR_STORE__!.openPrefs());
    await page.getByRole('button', { name: 'Links' }).click();
    const sec = page.getByTestId('prefs-links');
    await expect(sec.getByRole('radio', { name: 'In Patchroom' })).toBeChecked();
    await sec.getByRole('radio', { name: 'In my browser' }).check();
    await expect
      .poll(() => page.evaluate(() => window.__PR_STORE__!.getSnapshot().prefs?.links?.open))
      .toBe('browser');
  });
});
