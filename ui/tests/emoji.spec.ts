import { expect, test } from '@playwright/test';
import { chooseNew, openSeeded } from './helpers';

/** Emoji flavors: every name gets an emoji button; each pick is {char, flavor}; chat follows one setting. */

test.describe('emoji flavors', () => {
  test('the bundled Noto Color Emoji font loads', async ({ page }) => {
    await page.goto('/?mock');
    const ok = await page.evaluate(async () => {
      await document.fonts.load("16px 'Noto Color Emoji Patchroom'", '\u{1F600}');
      return document.fonts.check("16px 'Noto Color Emoji Patchroom'", '\u{1F600}');
    });
    expect(ok).toBe(true);
  });

  test('a section emoji picked in Noto is stored with its flavor', async ({ page }) => {
    await openSeeded(page, [], { sections: [{ id: 's1', name: 'Work' }] });
    await page.locator('[data-section="s1"] [data-testid="section-h"]').dblclick();
    await page.getByTestId('sec-emoji-btn').click();
    const picker = page.getByRole('dialog', { name: 'Section emoji' });
    await picker.getByTestId('emoji-flavor-noto').click();
    await expect(picker.locator('.emoji').first()).toHaveAttribute('data-flavor', 'noto');
    await picker.locator('[data-emoji="\u{1F680}"]').first().click();
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.sections().find((s) => s.id === 's1')))
      .toMatchObject({ emoji: '\u{1F680}', emojiFlavor: 'noto' });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-section="s1"] [data-testid="sec-emoji"]')).toHaveAttribute(
      'data-flavor',
      'noto',
    );
  });

  test('sessions: rename from the menu with an emoji', async ({ page }) => {
    await openSeeded(page, [{ id: 'd1', name: 'atlas' }]);
    await page.locator('[data-dm="d1"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename...' }).click();
    await page.getByTestId('sec-emoji-btn').click();
    const picker = page.getByRole('dialog', { name: 'Session emoji' });
    await picker.getByTestId('emoji-flavor-apple').click();
    await picker.locator('[data-emoji="✨"]').first().click();
    await page.getByLabel('Session name').fill('atlas api');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-dm="d1"] .nm')).toHaveText('atlas api');
    await expect(page.locator('[data-dm="d1"] [data-testid="dm-emoji"]')).toHaveText('✨');
    const s = await page.evaluate(() => window.__PR_MOCK__!.sessions().find((x) => x.id === 'd1'));
    expect(s).toMatchObject({ name: 'atlas api', emoji: '✨', emojiFlavor: 'apple' });
  });

  test('a new session can be named with an emoji', async ({ page }) => {
    await page.goto('/?mock');
    await chooseNew(page, 'New session');
    const dlg = page.getByRole('dialog', { name: 'New session' });
    await dlg.getByLabel('Folder').fill('/tmp/patchroom-emoji');
    await dlg.getByTestId('newdm-emoji').click();
    const picker = page.getByRole('dialog', { name: 'Session emoji' });
    await picker.getByTestId('emoji-flavor-noto').click();
    await picker.locator('[data-emoji="\u{1F525}"]').first().click();
    await dlg.getByRole('button', { name: 'Start session' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.sessionEmojis))
      .toEqual([expect.objectContaining({ emoji: '\u{1F525}', flavor: 'noto' })]);
  });

  test('Settings > Themes > Emoji in chat sets the chat flavor', async ({ page }) => {
    await page.goto('/?mock');
    await page.waitForFunction(() => !!window.__PR_STORE__?.getSnapshot().prefs);
    await expect(page.locator('.pr-app')).toHaveAttribute('data-emoji', 'apple');
    await page.evaluate(() => window.__PR_STORE__!.openPrefs({ tab: 'themes' }));
    await page
      .getByTestId('emoji-chat')
      .getByRole('radio', { name: /Noto Color/ })
      .check({ force: true });
    await expect(page.locator('.pr-app')).toHaveAttribute('data-emoji', 'noto');
    expect(await page.evaluate(() => window.__PR_MOCK__!.prefs().emoji)).toEqual({ chat: 'noto' });
  });
});
