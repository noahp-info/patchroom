import { expect, test, type Page } from '@playwright/test';
import { openChat, seedChat } from './helpers';
import { expectNoOverlap } from './qa';

/*
 * Queued messages. A message sent while the session is busy is Claude Code queued input: it
 * gets no transcript entry until Claude reads it. Chat shows it at once, below the live turn,
 * labeled Queued, until the entry arrives and replaces it. An interrupt or the session's end
 * leaves it Not sent, with Retry and Remove. The mock holds queued input the same way.
 */

const bubbles = (page: Page) => page.getByTestId('queued-msg');
const userRows = (page: Page) => page.locator('.msg[data-kind="user"]');

async function busy(page: Page, id: string) {
  await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'busy'), id);
}
async function send(page: Page, text: string) {
  const box = page.getByTestId('composer-input');
  await box.fill(text);
  await page.keyboard.press('Enter');
  await expect(box).toHaveValue('');
}

test('sent while busy: shown at once, in order, then replaced by the real message', async ({
  page,
}) => {
  const id = await openChat(page);
  await busy(page, id);
  await send(page, 'then check the tests');
  await send(page, 'and update the changelog');
  await expect(bubbles(page)).toHaveCount(2);
  await expect(bubbles(page).nth(0)).toContainText('then check the tests');
  await expect(bubbles(page).nth(1)).toContainText('and update the changelog');
  await expect(page.getByTestId('queued-tag').first()).toHaveText('Queued');
  // Below the live turn: the last rows of the log, and in view (auto-scroll follows them).
  const last = page.locator('[data-testid="chat-log"] .vrow').last();
  await expect(last.getByTestId('queued-msg')).toContainText('and update the changelog');
  await expect(bubbles(page).nth(1)).toBeInViewport();
  const before = await userRows(page).count();
  await expectNoOverlap(page);

  // A subagent's prompt is not the person's message: it replaces nothing.
  await page.evaluate((sid) => {
    window.__PR_MOCK__!.pushItems(sid, [
      {
        key: 'sub-user',
        ts: Date.now(),
        kind: 'user',
        text: 'then check the tests',
        images: [],
        parentToolUseId: 'tu-sub',
      },
    ]);
  }, id);
  await expect(bubbles(page)).toHaveCount(2);

  // Claude reads its queue: one entry with both, in order. Both bubbles go in that commit.
  await page.evaluate((sid) => {
    const m = window.__PR_MOCK__!;
    m.setStatus(sid, 'idle');
    m.setStatus(sid, 'busy');
    m.dequeue(sid);
  }, id);
  await expect(bubbles(page)).toHaveCount(0);
  await expect(userRows(page)).toHaveCount(before + 1);
  await expect(userRows(page).last()).toContainText('then check the tests');
  await expect(userRows(page).last()).toContainText('and update the changelog');
});

test('Send now types Ctrl+X Ctrl+S, and Claude reads the queue', async ({ page }) => {
  const id = await openChat(page);
  await busy(page, id);
  await send(page, 'skip the rest');
  await bubbles(page).getByTestId('queued-send-now').click();
  await expect(bubbles(page)).toHaveCount(0);
  await expect(userRows(page).last()).toContainText('skip the rest');
  const bytes = await page.evaluate((sid) => window.__PR_MOCK__!.writes[sid] ?? [], id);
  expect(bytes.slice(-2)).toEqual([0x18, 0x13]);
});

test('an interrupt leaves it Not sent; Retry sends it, Remove drops it', async ({ page }) => {
  const id = await openChat(page);
  await busy(page, id);
  await send(page, 'first idea');
  await send(page, 'second idea');
  // Stop (Esc): Claude Code puts the queued text back in its prompt and goes idle.
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('queued-tag')).toHaveText(['Not sent', 'Not sent'], {
    timeout: 8000,
  });
  await expect(bubbles(page).first()).toContainText('went back to Claude');
  await expectNoOverlap(page);
  await bubbles(page).last().getByTestId('queued-remove').click();
  await expect(bubbles(page)).toHaveCount(1);
  // Retry presses Enter on the text in Claude's prompt; the real message replaces the bubble.
  await bubbles(page).getByTestId('queued-retry').click();
  await expect(bubbles(page)).toHaveCount(0);
  await expect(userRows(page).last()).toContainText('first idea');
});

test('the session ending leaves it Not sent; Retry puts it back in the composer', async ({
  page,
}) => {
  const id = await openChat(page);
  await busy(page, id);
  await send(page, 'one more thing');
  await page.evaluate((sid) => window.__PR_MOCK__!.exit(sid, 0), id);
  await expect(page.getByTestId('queued-tag')).toHaveText('Not sent');
  await expect(bubbles(page)).toContainText('The session ended first.');
  await bubbles(page).getByTestId('queued-retry').click();
  await expect(bubbles(page)).toHaveCount(0);
  await expect(page.getByTestId('composer-input')).toHaveValue(/one more thing/);
});

test('a queued bubble follows like a sent message, and stays put when paused', async ({ page }) => {
  const id = await openChat(page);
  await seedChat(
    page,
    id,
    Array.from({ length: 60 }, (_, i) => ({
      key: `a${i}`,
      ts: Date.now() - (60 - i) * 1000,
      kind: 'assistant',
      text: `line ${i} `.repeat(8),
    })),
  );
  await busy(page, id);
  await send(page, 'at the bottom');
  await expect(bubbles(page)).toBeInViewport();
  // Scrolled up (paused): a new bubble does not pull the view down.
  await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 0));
  await page.getByTestId('chat-log').dispatchEvent('scroll');
  await page.waitForTimeout(150);
  await send(page, 'while reading');
  await expect(page.getByTestId('chat-log')).toHaveJSProperty('scrollTop', 0);
});
