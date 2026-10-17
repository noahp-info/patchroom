import { expect, test, type Page } from '@playwright/test';
import { openChat, watchErrors } from './helpers';

// Steering from anywhere in the window: screenshot-to-steer, comments on the side-pane page,
// claude.ai sign-in for the pane, and the first-time hint after Open in browser. Nothing here
// ever sends: every path ends as a draft line in the composer.

const ts = Date.UTC(2026, 9, 16, 10, 0);
const URL_A = 'https://claude.ai/artifact/CxWsf7LuBBuLJ791ZWKR1T';
const ITEMS = [{ key: 'm1', ts, kind: 'assistant', text: `Published it: ${URL_A}` }];
const mock = <T>(page: Page, fn: () => T) => page.evaluate(fn);
const lines = (page: Page) => page.getByTestId('comment-line');

async function openPane(page: Page): Promise<void> {
  await page.evaluate((u) => window.__PR_STORE__!.openLink(u, { target: 'patchroom' }), URL_A);
  await expect(page.getByTestId('viewer-title')).toHaveText('Page at claude.ai');
}

async function dragBox(page: Page, x: number, y: number, w: number, h: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + w, y + h, { steps: 5 });
  await page.mouse.up();
}

test.describe('screenshot to steer', () => {
  test('Cmd+Shift+2, a box over the pane, a note, Check: one composer line, nothing sent', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    const id = await openChat(page, ITEMS);
    await openPane(page);
    await page.keyboard.press('Meta+Shift+Digit2');
    const shot = page.getByTestId('shot');
    await expect(shot).toBeVisible();
    // The native pane stepped aside for the overlay.
    await expect
      .poll(() => mock(page, () => window.__PR_MOCK__!.viewer.join(' ')))
      .toMatch(/snapshot.*hide/);
    const vp = (await page.getByTestId('viewer').boundingBox())!;
    await dragBox(page, vp.x - 100, vp.y + 60, 260, 140);
    const note = page.getByLabel('Steer note');
    await expect(note).toBeFocused();
    // The note box pins to the box: just under it, starting at its left edge.
    const box = (await page.getByTestId('shot-box').boundingBox())!;
    const nb = (await page.getByTestId('shot-note').boundingBox())!;
    expect(Math.abs(nb.y - (box.y + box.height + 8))).toBeLessThanOrEqual(1);
    expect(Math.abs(nb.x - box.x)).toBeLessThanOrEqual(1);
    await note.fill('This button overlaps the title');
    await page.getByRole('button', { name: 'Add screenshot to message' }).click();
    await expect(shot).toHaveCount(0);
    await expect(lines(page)).toHaveCount(1);
    await expect(lines(page)).toHaveAttribute('data-kind', 'shot');
    await expect(page.getByTestId('comment-shot')).toBeVisible();
    await expect(page.getByLabel('Screenshot note')).toHaveValue('This button overlaps the title');
    // The crop is the dragged box, in CSS px of the window.
    const shots = await mock(page, () => window.__PR_MOCK__!.shots);
    expect(shots).toHaveLength(1);
    expect(shots[0].id).toBe(id);
    expect(shots[0].rect.width).toBeCloseTo(260, 0);
    expect(shots[0].rect.height).toBeCloseTo(140, 0);
    // Under 2 s from Check to the composer.
    expect(
      await page.evaluate(() => (window as { __PR_SHOT_MS__?: number }).__PR_SHOT_MS__),
    ).toBeLessThan(2000);
    // Nothing was sent; Send sends the path and the note together.
    expect(await mock(page, () => window.__PR_MOCK__!.sends)).toEqual([]);
    await page.getByRole('button', { name: 'Send' }).click();
    const sent = await mock(page, () => window.__PR_MOCK__!.sends);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/pastes\/.*-shot-1\.png'?\nThis button overlaps the title$/);
    // The pane came back.
    await expect.poll(() => mock(page, () => window.__PR_MOCK__!.viewer.at(-1))).toBe('reveal');
    expect(errs).toEqual([]);
  });

  test('X, Esc and a click without a drag discard; nothing reaches the composer', async ({
    page,
  }) => {
    await openChat(page, ITEMS);
    await page.getByTestId('shot-btn').click();
    await expect(page.getByTestId('shot')).toBeVisible();
    // A click is not a box.
    await page.mouse.click(400, 300);
    await expect(page.getByTestId('shot-note')).toHaveCount(0);
    await dragBox(page, 300, 200, 120, 80);
    await page.getByRole('button', { name: 'Discard screenshot' }).click();
    await expect(page.getByTestId('shot')).toHaveCount(0);
    await page.getByTestId('shot-btn').click();
    await dragBox(page, 300, 200, 120, 80);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shot')).toHaveCount(0);
    await expect(lines(page)).toHaveCount(0);
    expect(await mock(page, () => window.__PR_MOCK__!.shots)).toEqual([]);
  });
});

test.describe('comment on the side-pane selection', () => {
  test('Cmd+Shift+M from the menu reads the page selection into a linked draft line', async ({
    page,
  }) => {
    await openChat(page, ITEMS);
    await openPane(page);
    await page.evaluate(() => {
      window.__PR_MOCK__!.viewerPicked = 'The quarterly totals do not add up';
    });
    // The real app's menu accelerator fires even while the pane has focus.
    await page.evaluate(() => window.__PR_MOCK__!.menuComment());
    await expect(lines(page)).toHaveCount(1);
    const quote = lines(page).locator('.cline__quote');
    await expect(quote).toContainText('The quarterly totals do not add up');
    await expect(quote).toHaveAttribute(
      'data-link',
      `${URL_A}#:~:text=The%20quarterly%20totals%20do%20not%20add%20up`,
    );
    // The jump back scrolls the open page to the quote.
    await quote.click();
    expect(await mock(page, () => window.__PR_MOCK__!.viewer.at(-1))).toBe(
      'find The quarterly totals do not add up',
    );
    // Draft only.
    expect(await mock(page, () => window.__PR_MOCK__!.sends)).toEqual([]);
    await page.getByTestId('comment-note').fill('Check the math');
    await page.getByRole('button', { name: 'Send' }).click();
    const sent = await mock(page, () => window.__PR_MOCK__!.sends);
    expect(sent[0].text).toBe(
      `> The quarterly totals do not add up\n(from ${URL_A})\nCheck the math`,
    );
  });

  test('a long selection links back with a start,end text range', async ({ page }) => {
    await openChat(page, ITEMS);
    await openPane(page);
    await page.evaluate(() => {
      window.__PR_MOCK__!.viewerPicked =
        'one two three four five six seven eight nine ten eleven twelve-thirteen';
    });
    await page.getByTestId('viewer-comment').click();
    await expect(lines(page).locator('.cline__quote')).toHaveAttribute(
      'data-link',
      `${URL_A}#:~:text=one%20two%20three%20four%20five,eight%20nine%20ten%20eleven%20twelve%2Dthirteen`,
    );
  });

  test('a selection in Patchroom itself comments at once, no pane needed', async ({ page }) => {
    await openChat(page, ITEMS);
    await page.locator('.msg[data-key="m1"] .body').selectText();
    await page.keyboard.press('Meta+Shift+m');
    await expect(lines(page)).toHaveCount(1);
    expect(await mock(page, () => window.__PR_MOCK__!.viewer)).toEqual([]);
  });
});

test.describe('claude.ai in the side pane', () => {
  test('Settings > Accounts signs in once in the pane and signs out', async ({ page }) => {
    await openChat(page, ITEMS);
    await page.keyboard.press('Meta+,');
    const dlg = page.getByRole('dialog', { name: 'Settings' });
    await dlg.getByRole('button', { name: 'Accounts', exact: true }).click();
    const row = page.getByTestId('account-claude');
    await expect(row).toContainText('Not checked yet');
    await row.getByRole('button', { name: 'Sign in' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId('viewer')).toBeVisible();
    expect(await mock(page, () => window.__PR_MOCK__!.viewer[0])).toBe(
      'show https://claude.ai/login',
    );
    await page.evaluate(() => window.__PR_MOCK__!.viewerAccount(true));
    await page.keyboard.press('Meta+,');
    await dlg.getByRole('button', { name: 'Accounts', exact: true }).click();
    await expect(row).toContainText('Signed in');
    await row.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('account-note')).toContainText('Signed out');
    await expect(row).toContainText('Not signed in');
    expect(await mock(page, () => window.__PR_MOCK__!.viewer)).toContain('signout');
  });

  test('an artifact asking to sign in shows Sign in in the pane and comes back after', async ({
    page,
  }) => {
    await openChat(page, ITEMS);
    await openPane(page);
    await page.evaluate((u) => window.__PR_MOCK__!.viewerAccount(false, u), URL_A);
    const strip = page.getByTestId('viewer-signin');
    await expect(strip).toBeVisible();
    await strip.getByRole('button', { name: 'Sign in' }).click();
    const lastShow = () =>
      mock(page, () => window.__PR_MOCK__!.viewer.filter((v) => v.startsWith('show')).at(-1));
    await expect.poll(lastShow).toBe('show https://claude.ai/login');
    await page.evaluate(() => window.__PR_MOCK__!.viewerAccount(true, 'https://claude.ai/new'));
    await expect
      .poll(() =>
        mock(page, () => window.__PR_MOCK__!.viewer.filter((v) => v.startsWith('show')).at(-1)),
      )
      .toBe(`show ${URL_A}`);
    await expect(strip).toHaveCount(0);
  });
});

test.describe('first-time hints', () => {
  test('the first Open in browser leads to one hint on return, with a button to Settings > Links', async ({
    page,
  }) => {
    await openChat(page, ITEMS);
    await openPane(page);
    await page.getByTestId('viewer-browser').click();
    // Nothing yet: the hint waits for the person to come back to Patchroom.
    await expect(page.getByTestId('hint')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const hint = page.getByTestId('hint');
    await expect(hint).toContainText(
      'Want links to always open in your browser? Change it in Settings > Links.',
    );
    // It never blocks: the composer still takes text while it shows.
    await page.getByTestId('composer-input').fill('still typing');
    await hint.getByRole('button', { name: 'Open Links settings' }).click();
    await expect(page.getByTestId('prefs-links')).toBeVisible();
    await expect(hint).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Seen once: never again, also after a reload.
    await page.getByTestId('viewer-browser').click();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByTestId('hint')).toHaveCount(0);
    expect(
      await page.evaluate(() => window.__PR_STORE__!.getSnapshot().prefs?.hints?.seen),
    ).toEqual(['links.browser']);
  });

  test('a hint dismisses with its X', async ({ page }) => {
    await openChat(page, ITEMS);
    await openPane(page);
    await page.getByTestId('viewer-browser').click();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Dismiss hint' }).click();
    await expect(page.getByTestId('hint')).toHaveCount(0);
  });
});
