import { expect, test, type Page } from '@playwright/test';
import { openChat } from './helpers';

// Artifacts: pinned once automatically (an unpin sticks), listed in Pins with Open, and a URL
// the CLI opens (BROWSER -> patchroom-hook -> link:open) follows the Links preference.

const ts = Date.UTC(2026, 9, 15, 10, 0);
const ART = 'https://claude.ai/artifact/CxWsf7LuBBuLJ791ZWKR1T';
const pins = (page: Page, id: string) =>
  page.evaluate(
    (sid) =>
      window
        .__PR_STORE__!.getSnapshot()
        .marks.filter((m) => m.conversationId === sid && m.kind === 'pin')
        .map((m) => m.itemKey),
    id,
  );
const push = (page: Page, id: string, key: string, text: string) =>
  page.evaluate(
    ({ sid, key, text }) =>
      window.__PR_MOCK__!.pushItems(sid, [{ key, ts: Date.now(), kind: 'assistant', text }]),
    { sid: id, key, text },
  );

test.describe('artifacts', () => {
  test('a new artifact is pinned once, shows in Pins with Open, and an unpin sticks', async ({
    page,
  }) => {
    const id = await openChat(page, [{ key: 'm0', ts, kind: 'assistant', text: 'Hello.' }]);
    await push(page, id, 'a1', `Here it is: ${ART}`);
    await expect.poll(() => pins(page, id)).toEqual(['a1']);
    await push(page, id, 'n1', 'No link here.');
    expect(await pins(page, id)).toEqual(['a1']);

    // Pins list: the artifact row has a tag and Open, which opens the viewer.
    await page.getByTestId('pins-btn').click();
    const row = page.locator('.markrow[data-artifact="true"]');
    await expect(row).toBeVisible();
    await expect(row.locator('.markrow__tag')).toHaveText('Artifact');
    await row.getByTestId('artifact-open').click();
    await expect(page.getByTestId('viewer')).toBeVisible();

    // Unpin, then the same item arrives again (a reload): it stays unpinned.
    await page.evaluate((sid) => window.__PR_STORE__!.toggleMark(sid, 'a1', 'pin'), id);
    await expect.poll(() => pins(page, id)).toEqual([]);
    await push(page, id, 'a1', `Here it is: ${ART}`);
    await page.waitForTimeout(200);
    expect(await pins(page, id)).toEqual([]);
  });

  test('with auto-pin off, artifacts are not pinned', async ({ page }) => {
    const id = await openChat(page, [{ key: 'm0', ts, kind: 'assistant', text: 'Hello.' }]);
    await page.evaluate(() => window.__PR_STORE__!.setPrefs({ artifacts: { autoPin: false } }));
    await push(page, id, 'a2', `Published: ${ART}`);
    await page.waitForTimeout(200);
    expect(await pins(page, id)).toEqual([]);
  });

  test('a URL the CLI opens follows the Links preference', async ({ page }) => {
    await openChat(page, []);
    await page.evaluate((u) => window.__PR_MOCK__!.cliOpenUrl(u), ART);
    await expect(page.getByTestId('viewer')).toBeVisible();
    await page.getByTestId('viewer-close').click();
    await page.evaluate(() => window.__PR_STORE__!.setPrefs({ links: { open: 'browser' } }));
    await page.evaluate((u) => window.__PR_MOCK__!.cliOpenUrl(u), ART);
    await expect.poll(() => page.evaluate(() => window.__PR_MOCK__!.external)).toEqual([ART]);
  });
});
