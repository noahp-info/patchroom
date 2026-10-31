import { expect, test, type Page } from '@playwright/test';
import { openSeeded, watchErrors } from './helpers';

const T0 = Date.parse('2026-10-13T09:00:00Z');
const chat = (tag: string, n = 600) =>
  Array.from({ length: n }, (_, i) => ({
    key: `${tag}-${i}`,
    ts: T0 + i * 30_000,
    kind: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `${tag} message ${i}: ${i === 5 ? 'the retry budget is five' : 'routine text'}`,
    ...(i % 2 === 0 ? { images: [] } : {}),
  }));

const msg = (page: Page, key: string) => page.locator(`.msg[data-key="${key}"]`);
const bar = (page: Page, key: string) =>
  msg(page, key).getByRole('toolbar', { name: 'Message actions' });

async function setup(page: Page, query = 'mock&grid=100x30') {
  await openSeeded(
    page,
    [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
    ],
    { query },
  );
  await page.evaluate(
    ({ a, b }) => {
      const m = window.__PR_MOCK__!;
      m.seedChat('a', a as never);
      m.seedChat('b', b as never);
    },
    { a: chat('a'), b: chat('b') },
  );
  await page.evaluate(() => window.__PR_STORE__!.openDm('a'));
  await expect(msg(page, 'a-599')).toBeVisible();
}

/** Scroll the log to the top of the last page so low keys render. */
async function showKey(page: Page, key: string) {
  await page.evaluate((k) => window.__PR_STORE__!.chat('a').openAt(k), key);
  await expect(msg(page, key)).toBeVisible();
}

test.describe('workspace: hover bar, pins and Saved (checklist 8)', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('the hover bar offers Copy, React, Pin and Save', async ({ page }) => {
    const errs = watchErrors(page);
    await setup(page);
    await msg(page, 'a-598').hover();
    const b = bar(page, 'a-598');
    for (const name of ['Copy', 'React', 'Pin', 'Save']) {
      await expect(b.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await b.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(b.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'a message 598: routine text',
    );
    expect(errs).toEqual([]);
  });

  test('pins list per DM and jump to the message; Saved lists across DMs', async ({ page }) => {
    await setup(page);
    await showKey(page, 'a-5');
    await msg(page, 'a-5').hover();
    await bar(page, 'a-5').getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(msg(page, 'a-5').locator('.mtag[data-mark="pin"]')).toBeVisible();
    await msg(page, 'a-5').hover();
    await bar(page, 'a-5').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(msg(page, 'a-5').locator('.mtag[data-mark="saved"]')).toBeVisible();

    // A save in the other DM too.
    await page.evaluate(() => window.__PR_STORE__!.openDm('b'));
    await expect(msg(page, 'b-599')).toBeVisible();
    await msg(page, 'b-599').hover();
    await bar(page, 'b-599').getByRole('button', { name: 'Save', exact: true }).click();

    // Back in alpha, scroll to the end, open Pins and jump to the pinned message.
    await page.evaluate(() => window.__PR_STORE__!.openDm('a'));
    await page
      .getByTestId('jump-latest')
      .click()
      .catch(() => undefined);
    await page.getByTestId('pins-btn').click();
    const pins = page.getByTestId('pins-list');
    await expect(pins.locator('.markrow')).toHaveCount(1);
    await expect(pins).toContainText('the retry budget is five');
    await pins.locator('.markrow__main').click();
    await expect(msg(page, 'a-5')).toHaveAttribute('data-hit', 'true');

    // Saved lists both DMs' items and jumps across DMs.
    await page.getByTestId('nav-saved').click();
    const saved = page.getByTestId('saved-list').locator('.markrow');
    await expect(saved).toHaveCount(2);
    await expect(page.getByTestId('saved-list')).toContainText('alpha');
    await expect(page.getByTestId('saved-list')).toContainText('beta');
    await saved.filter({ hasText: 'beta' }).locator('.markrow__main').click();
    expect(await page.evaluate(() => window.__PR_STORE__!.getSnapshot().activeId)).toBe('b');
    await expect(msg(page, 'b-599')).toHaveAttribute('data-hit', 'true');

    // Unsave from the list.
    await page.getByTestId('nav-saved').click();
    await page
      .getByTestId('saved-list')
      .locator('.markrow')
      .first()
      .getByRole('button', { name: 'Remove saved item' })
      .click();
    await expect(page.getByTestId('saved-list').locator('.markrow')).toHaveCount(1);
  });

  test('pins and saved items survive an app restart', async ({ page }) => {
    await setup(page, 'mock&persist');
    await showKey(page, 'a-5');
    await msg(page, 'a-5').hover();
    await bar(page, 'a-5').getByRole('button', { name: 'Pin', exact: true }).click();
    await msg(page, 'a-5').hover();
    await bar(page, 'a-5').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__PR_MOCK__!.storedMarks().length)).toBe(2);
    await page.reload();
    await page.getByTestId('nav-saved').click();
    await expect(page.getByTestId('saved-list').locator('.markrow')).toHaveCount(1);
    // Jump from Saved into the DM: the message still carries both marks.
    await page.getByTestId('saved-list').locator('.markrow__main').click();
    await expect(msg(page, 'a-5').locator('.mtag[data-mark="pin"]')).toBeVisible();
    await expect(msg(page, 'a-5').locator('.mtag[data-mark="saved"]')).toBeVisible();
    await expect(page.getByTestId('pins-btn')).toContainText('1');
  });
});

test.describe('workspace: reactions (checklist 9)', () => {
  test('emoji picker with recents; a reaction is a label that can be filtered on', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await setup(page);
    await showKey(page, 'a-5');
    // First open: no recents yet.
    await msg(page, 'a-5').hover();
    await bar(page, 'a-5').getByRole('button', { name: 'React', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Add a reaction' });
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('emoji-recent')).toHaveCount(0);
    await picker.getByRole('button', { name: ':white_check_mark:' }).click();
    const chip = msg(page, 'a-5').locator('.rchip[data-emoji="✅"]');
    await expect(chip).toBeVisible();

    // Another message gets a different emoji; the picker now lists both as recent.
    await showKey(page, 'a-7');
    await msg(page, 'a-7').hover();
    await bar(page, 'a-7').getByRole('button', { name: 'React', exact: true }).click();
    await expect(page.getByTestId('emoji-recent').locator('.emoji')).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Find an emoji' }).fill('rocket');
    await page.getByRole('searchbox', { name: 'Find an emoji' }).press('Enter');
    await expect(msg(page, 'a-7').locator('.rchip[data-emoji="\u{1F680}"]')).toBeVisible();

    // Filter: show only messages with :white_check_mark:.
    await page.getByTestId('reaction-filter-btn').click();
    await page.getByRole('menuitemradio', { name: /white_check_mark/ }).click();
    await expect(page.getByTestId('reaction-filter-on')).toContainText(':white_check_mark:');
    await expect(page.locator('.vrow .msg')).toHaveCount(1);
    await expect(msg(page, 'a-5')).toBeVisible();
    await expect(msg(page, 'a-7')).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear reaction filter' }).click();
    await expect(page.getByTestId('reaction-filter-on')).toHaveCount(0);
    await expect.poll(() => page.locator('.vrow .msg').count()).toBeGreaterThan(1);

    // Clicking the chip removes the reaction.
    await showKey(page, 'a-5');
    await chip.click();
    await expect(chip).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('a reaction is never written to the PTY or sent as text', async ({ page }) => {
    await setup(page);
    await showKey(page, 'a-5');
    await msg(page, 'a-5').hover();
    await bar(page, 'a-5').getByRole('button', { name: 'React', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add a reaction' })
      .getByRole('button', { name: ':+1:' })
      .click();
    await msg(page, 'a-5').hover();
    await bar(page, 'a-5').getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(msg(page, 'a-5').locator('.rchip')).toBeVisible();
    const sent = await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      return {
        bytes: Object.values(m.writes).flat().length,
        texts: m.texts.length,
        marks: m
          .storedMarks()
          .map((x) => x.kind)
          .sort(),
      };
    });
    expect(sent).toEqual({ bytes: 0, texts: 0, marks: ['pin', 'reaction'] });
  });

  test('reactions survive an app restart', async ({ page }) => {
    await setup(page, 'mock&persist');
    await showKey(page, 'a-5');
    await msg(page, 'a-5').hover();
    await bar(page, 'a-5').getByRole('button', { name: 'React', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add a reaction' })
      .getByRole('button', { name: ':tada:' })
      .click();
    await expect.poll(() => page.evaluate(() => window.__PR_MOCK__!.storedMarks().length)).toBe(1);
    await page.reload();
    await page.locator('.side .row', { hasText: 'alpha' }).click();
    await page.evaluate(() => window.__PR_STORE__!.chat('a').openAt('a-5'));
    await expect(msg(page, 'a-5').locator('.rchip[data-emoji="\u{1F389}"]')).toBeVisible();
  });
});
