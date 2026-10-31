import { expect, test, type Page } from '@playwright/test';
import { openChat } from './helpers';

/*
 * Composer history, like Claude Code's prompt: Up in an empty box (or on its first line) brings
 * back this session's messages, newest first; Down walks forward and then restores the draft;
 * Esc restores it too. Up with queued messages takes them back out of Claude's queue.
 */

const user = (key: string, text: string, ts: number) => ({
  key,
  ts,
  kind: 'user',
  text,
  images: [],
});
const reply = (key: string, text: string, ts: number) => ({ key, ts, kind: 'assistant', text });

const ITEMS = [
  user('u1', 'first message', 1),
  reply('a1', 'ok one', 2),
  user('u2', 'second message', 3),
  reply('a2', 'ok two', 4),
  user('u3', '/model haiku', 5),
  user('u4', 'third message', 6),
];

const box = (page: Page) => page.getByTestId('composer-input');
const caret = (page: Page) =>
  box(page).evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
const setCaret = (page: Page, at: number) =>
  box(page).evaluate((el: HTMLTextAreaElement, n) => el.setSelectionRange(n, n), at);

async function open(page: Page, items: unknown[] = ITEMS): Promise<string> {
  const id = await openChat(page, items);
  await box(page).click();
  return id;
}

test('Up walks back newest first, slash commands included; Down returns to the draft', async ({
  page,
}) => {
  await open(page);
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('third message');
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('/model haiku');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('first message');
  // Nothing further back: the oldest stays.
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('first message');
  await page.keyboard.press('ArrowDown');
  await expect(box(page)).toHaveValue('second message');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(box(page)).toHaveValue('third message');
  // Past the newest: the (empty) draft from before.
  await page.keyboard.press('ArrowDown');
  await expect(box(page)).toHaveValue('');
});

test('a one-line draft comes back after cycling, by Down or by Esc', async ({ page }) => {
  await open(page);
  await page.keyboard.type('half written');
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('third message');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(box(page)).toHaveValue('half written');
  expect(await caret(page)).toEqual([12, 12]);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await expect(box(page)).toHaveValue('half written');
});

test('the multi-line caret: Up only from the first line, Down only from the last', async ({
  page,
}) => {
  await open(page, [user('u1', 'line one\nline two\nline three', 1), user('u2', 'newest', 2)]);
  await page.keyboard.type('draft a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('draft b');
  // Caret on the second line: Up moves the caret, nothing is recalled.
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('draft a\ndraft b');
  const [at] = await caret(page);
  expect(at).toBeLessThanOrEqual(7);
  // Now on the first line: Up recalls.
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('newest');
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('line one\nline two\nline three');
  // The caret sits at the start of a recalled message: Down first walks its lines.
  expect(await caret(page)).toEqual([0, 0]);
  await page.keyboard.press('ArrowDown');
  await expect(box(page)).toHaveValue('line one\nline two\nline three');
  await setCaret(page, 'line one\nline two\nline three'.length);
  await page.keyboard.press('ArrowDown');
  await expect(box(page)).toHaveValue('newest');
  await page.keyboard.press('ArrowDown');
  await expect(box(page)).toHaveValue('draft a\ndraft b');
});

test('a wrapped first line moves the caret before it recalls', async ({ page }) => {
  await open(page);
  const long = 'word '.repeat(80).trim();
  await box(page).fill(long);
  await setCaret(page, long.length);
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue(long);
});

test('editing a recalled message makes a new message; history is unchanged', async ({ page }) => {
  const id = await open(page);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.type(' again');
  // Edited: Esc no longer swaps it back.
  await page.keyboard.press('Escape');
  await expect(box(page)).toHaveValue('third message again');
  await page.keyboard.press('Enter');
  await expect(box(page)).toHaveValue('');
  const sends = await page.evaluate(
    (sid) => window.__PR_MOCK__!.texts.filter((t) => t.id === sid),
    id,
  );
  expect(sends.map((t) => t.text)).toEqual(['third message again']);
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('third message again');
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('third message');
});

test('a message sent from Patchroom counts before its transcript entry lands', async ({ page }) => {
  await open(page, []);
  await page.evaluate(() => (window.__PR_MOCK__!.autoEcho = false));
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('');
  await page.keyboard.type('not echoed yet');
  await page.keyboard.press('Enter');
  await expect(box(page)).toHaveValue('');
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('not echoed yet');
});

test('Up with queued messages takes them back out of the queue, terminal style', async ({
  page,
}) => {
  const id = await open(page);
  await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'busy'), id);
  for (const t of ['then run the tests', 'and the linter']) {
    await box(page).fill(t);
    await page.keyboard.press('Enter');
    await expect(box(page)).toHaveValue('');
  }
  await expect(page.getByTestId('queued-msg')).toHaveCount(2);
  await page.evaluate((sid) => (window.__PR_MOCK__!.writes[sid] = []), id);
  await page.keyboard.press('ArrowUp');
  // Claude Code's Up pulls its whole queue into the prompt, joined by newlines.
  await expect(box(page)).toHaveValue('then run the tests\nand the linter');
  await expect(page.getByTestId('queued-msg')).toHaveCount(0);
  const w = await page.evaluate((sid) => {
    const m = window.__PR_MOCK__!;
    return { bytes: m.writes[sid], queue: m.queuedInput[sid], pulled: m.pulled[sid] };
  }, id);
  const s = String.fromCharCode(...w.bytes);
  expect(s.startsWith('\x1b[A')).toBe(true);
  // Enough backspaces to clear what Up put in Claude's prompt.
  expect(
    s
      .slice(3)
      .split('')
      .every((c) => c === '\x7f'),
  ).toBe(true);
  expect(s.length - 3).toBeGreaterThan('then run the tests\nand the linter'.length);
  expect(w.queue).toEqual([]);
  expect(w.pulled).toEqual(['then run the tests', 'and the linter']);
  // The pulled text is a normal draft: the next Up on its first line walks history.
  await setCaret(page, 0);
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('third message');
});

test('a picker or a handler before the box keeps the arrow keys and Esc', async ({ page }) => {
  await open(page);
  // A combobox picker open on the box (the @ and / picker contract).
  await box(page).evaluate((el) => el.setAttribute('aria-expanded', 'true'));
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('');
  await box(page).evaluate((el) => el.removeAttribute('aria-expanded'));
  // A picker that handles keys first (capture) wins.
  await page.evaluate(() => {
    window.addEventListener(
      'keydown',
      (e) => {
        if ((window as unknown as { __takeKeys?: boolean }).__takeKeys) e.preventDefault();
      },
      true,
    );
  });
  await page.evaluate(() => ((window as unknown as { __takeKeys?: boolean }).__takeKeys = true));
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('');
  await page.evaluate(() => ((window as unknown as { __takeKeys?: boolean }).__takeKeys = false));
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('third message');
  await page.evaluate(() => ((window as unknown as { __takeKeys?: boolean }).__takeKeys = true));
  await page.keyboard.press('Escape');
  await expect(box(page)).toHaveValue('third message');
});

test('the third message shows the hint once, and it opens the setting', async ({ page }) => {
  await open(page, []);
  for (const t of ['one', 'two', 'three']) {
    await box(page).fill(t);
    await page.keyboard.press('Enter');
    await expect(box(page)).toHaveValue('');
  }
  const hint = page.locator('[data-hint="composer.history"]');
  await expect(hint).toContainText('Press ↑ to bring back a previous message');
  await hint.getByRole('button', { name: 'Composer settings' }).click();
  const dlg = page.getByRole('dialog', { name: 'Settings' });
  const row = dlg.locator('[data-setting="themes.uphistory"]');
  await expect(row).toBeVisible();
  // Off: Up only moves the caret.
  await row.getByRole('checkbox').uncheck();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await box(page).click();
  await page.keyboard.press('ArrowUp');
  await expect(box(page)).toHaveValue('');
});
