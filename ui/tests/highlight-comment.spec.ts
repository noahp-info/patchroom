import { expect, test, type Page } from '@playwright/test';
import { openChat, watchErrors } from './helpers';

// Highlight-to-comment (docs/SPEC.md 3.2): select text, Comment adds a linked line to the
// composer, nothing sends before Send, Copy and Search work, native fields keep their menus.

const ts = Date.UTC(2026, 9, 15, 10, 0);
const ITEMS = [
  { key: 'a1', ts, kind: 'assistant', text: 'I will refactor the parser into three passes.' },
  { key: 'a2', ts, kind: 'assistant', text: 'Then the cache layer gets a write-through mode.' },
];
const texts = (page: Page) => page.evaluate(() => window.__PR_MOCK__!.texts.map((t) => t.text));

/** Select `phrase` inside row `key`, as a drag would. */
async function select(page: Page, key: string, phrase: string) {
  await page.evaluate(
    ({ key, phrase }) => {
      const row = document.querySelector(`.msg[data-key="${key}"]`)!;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = n.textContent!.indexOf(phrase);
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + phrase.length);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      throw new Error(`no "${phrase}" in ${key}`);
    },
    { key, phrase },
  );
}

/** Right-click the middle of the current selection, as a user does. */
async function rightClickSelection(page: Page) {
  const r = await page.evaluate(() => {
    const b = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(r.x, r.y, { button: 'right' });
}

async function selectAndRelease(page: Page, key: string, phrase: string) {
  await select(page, key, phrase);
  const box = await page.locator(`.msg[data-key="${key}"]`).boundingBox();
  await page.mouse.move(box!.x + 40, box!.y + box!.height / 2);
  // A mouseup ends the drag; the chip reads the selection then.
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { button: 0 })));
}

test.describe('highlight to comment', () => {
  test('the chip adds a linked comment line; Send sends quote then note, once', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openChat(page, ITEMS);
    await selectAndRelease(page, 'a1', 'three passes');
    const chip = page.getByTestId('selection-chip');
    await expect(chip).toBeVisible();
    await page.getByTestId('selchip-comment').click();
    await expect(chip).toHaveCount(0);

    const line = page.getByTestId('comment-line');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText('three passes');
    // The note box has focus; typing there sends nothing.
    const note = page.getByTestId('comment-note');
    await expect(note).toBeFocused();
    await note.pressSequentially('why three and not two?');
    await page.keyboard.press('Enter');
    expect(await texts(page)).toEqual([]);
    await expect(page.getByTestId('composer-input')).toBeFocused();
    // The source row stays marked while the line waits.
    await expect(page.locator('.msg[data-key="a1"]')).toHaveAttribute('data-commented', 'true');

    await page.getByTestId('composer-input').pressSequentially('Otherwise looks good.');
    await page.keyboard.press('Enter');
    expect(await texts(page)).toEqual([
      '> three passes\nwhy three and not two?\n\nOtherwise looks good.',
    ]);
    await expect(line).toHaveCount(0);
    await expect(page.locator('.msg[data-key="a1"]')).not.toHaveAttribute('data-commented');
    expect(errs).toEqual([]);
  });

  test('a comment alone can be sent, and lines can be removed', async ({ page }) => {
    await openChat(page, ITEMS);
    await selectAndRelease(page, 'a1', 'refactor the parser');
    await page.getByTestId('selchip-comment').click();
    await selectAndRelease(page, 'a2', 'write-through mode');
    await page.getByTestId('selchip-comment').click();
    await expect(page.getByTestId('comment-line')).toHaveCount(2);
    await page.getByRole('button', { name: 'Remove comment' }).first().click();
    await expect(page.getByTestId('comment-line')).toHaveCount(1);
    await page.getByTestId('comment-note').fill('use write-back instead');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await page.getByRole('button', { name: 'Send' }).click();
    expect(await texts(page)).toEqual(['> write-through mode\nuse write-back instead']);
  });

  test('clicking the quote jumps back to its source row', async ({ page }) => {
    await openChat(page, ITEMS);
    await selectAndRelease(page, 'a2', 'cache layer');
    await page.getByTestId('selchip-comment').click();
    await page.locator('.cline__quote').click();
    await expect(page.locator('.msg[data-key="a2"]')).toHaveAttribute('data-hit', 'true');
  });

  test('the chip copies the selection without touching the composer', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openChat(page, ITEMS);
    await selectAndRelease(page, 'a1', 'parser');
    await page.getByTestId('selchip-copy').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('parser');
    await expect(page.getByTestId('comment-line')).toHaveCount(0);
  });

  test('right-click on a selection offers Comment, Copy and Search', async ({ page }) => {
    await openChat(page, ITEMS);
    await select(page, 'a2', 'cache layer');
    await rightClickSelection(page);
    const menu = page.getByRole('menu', { name: 'Selection' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Comment',
      'Copy',
      'Search for “cache layer”',
    ]);
    await menu.getByRole('menuitem', { name: /Search for/ }).click();
    await expect(page.getByRole('searchbox').or(page.locator('.search input'))).toHaveValue(
      'cache layer',
    );
  });

  test('right-click Comment works too', async ({ page }) => {
    await openChat(page, ITEMS);
    await select(page, 'a1', 'three passes');
    await rightClickSelection(page);
    await page.getByRole('menuitem', { name: 'Comment' }).click();
    await expect(page.getByTestId('comment-line')).toContainText('three passes');
  });

  test('text fields keep the native menu, and no chip shows without a selection', async ({
    page,
  }) => {
    await openChat(page, ITEMS);
    const box = page.getByTestId('composer-input');
    await box.fill('draft text');
    await box.selectText();
    await box.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Selection' })).toHaveCount(0);
    await page.locator('.msg[data-key="a1"]').click();
    await expect(page.getByTestId('selection-chip')).toHaveCount(0);
  });

  test('the exact quoted words stay marked, stronger while the note is edited', async ({
    page,
  }) => {
    await openChat(page, [
      { key: 'r1', ts, kind: 'assistant', text: 'Holly is evergreen. Jasmine is evergreen too.' },
    ]);
    // The second "evergreen", not the first.
    await page.evaluate(() => {
      const row = document.querySelector('.msg[data-key="r1"]')!;
      const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const at = n.textContent!.lastIndexOf('evergreen');
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + 9);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
      }
      document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    });
    await page.getByTestId('selchip-comment').click();
    await expect(page.getByTestId('comment-note')).toBeFocused();
    const marked = (name: string) =>
      page.evaluate((n) => {
        const h = CSS.highlights.get(n);
        if (!h) return null;
        const [r] = [...h] as Range[];
        if (!r) return null;
        const pre = document.createRange();
        pre.setStart(r.startContainer.parentElement!.closest('.msg')!, 0);
        pre.setEnd(r.startContainer, r.startOffset);
        return { text: r.toString(), before: pre.toString() };
      }, name);
    await expect.poll(() => marked('pr-comment-active')).toMatchObject({ text: 'evergreen' });
    expect((await marked('pr-comment-active'))!.before).toContain('Jasmine is ');
    // Leaving the note keeps the mark, at the normal strength.
    await page.getByTestId('composer-input').focus();
    await expect.poll(() => marked('pr-comment')).toMatchObject({ text: 'evergreen' });
    expect(await marked('pr-comment-active')).toBeNull();
    // Sending clears it.
    await page.getByTestId('composer-input').press('Enter');
    await expect.poll(() => marked('pr-comment')).toBeNull();
  });

  test('a sent comment shows its quote as a quote', async ({ page }) => {
    await openChat(page, ITEMS);
    await selectAndRelease(page, 'a1', 'three passes');
    await page.getByTestId('selchip-comment').click();
    await page.getByTestId('comment-note').fill('why three?');
    await page.getByTestId('comment-note').press('Meta+Enter');
    const sent = page.locator('.msg[data-kind="user"]').last();
    await expect(sent.locator('blockquote.uq')).toHaveText('three passes');
    await expect(sent.locator('.usertext > p')).toHaveText('why three?');
  });
});
