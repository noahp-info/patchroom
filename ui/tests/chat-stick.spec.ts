import { expect, test } from '@playwright/test';
import { openChat, watchErrors } from './helpers';

// The log keeps following the bottom when the viewport shrinks under it, for example when the
// status strip gains a line while the user is reading the newest message. Found by the live e2e
// run: a plan widget arrived after the strip grew and sat below the fold.

test('the log stays pinned to the bottom when the status strip grows', async ({ page }) => {
  const errs = watchErrors(page);
  const id = await openChat(page);
  const log = page.getByTestId('chat-log');
  const gap = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(gap).toBeLessThanOrEqual(2);

  await page.evaluate((sid) => {
    const lines = Array.from({ length: 4 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m status`);
    window.__PR_MOCK__!.setStatusline(sid, lines.join('\n'), { model: 'Haiku 5.5', mode: 'plan' });
  }, id);
  await expect(page.getByTestId('statusline')).toContainText('line 4');
  await expect.poll(gap).toBeLessThanOrEqual(2);

  await page.evaluate((sid) => {
    const plan = Array.from({ length: 14 }, (_, i) => `${i + 1}. Step number ${i + 1}`).join('\n');
    window.__PR_MOCK__!.emitPrompt(sid, {
      promptId: 'p-plan-tall',
      kind: 'plan',
      toolName: 'ExitPlanMode',
      toolInput: { plan },
      toolUseId: 'tu-plan-tall',
    });
  }, id);
  const ask = page.locator('.ask[data-kind="plan"][data-state="pending"]');
  await expect(ask).toBeVisible();
  await expect(ask.getByRole('button', { name: 'Approve plan' })).toBeInViewport();
  await expect.poll(gap).toBeLessThanOrEqual(2);
  expect(errs).toEqual([]);
});

test('the log follows new rows after the composer grows under a pinned view', async ({ page }) => {
  const id = await openChat(page);
  const log = page.getByTestId('chat-log');
  const gap = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  const box = page.getByTestId('composer-input');
  await box.focus();
  await box.pressSequentially('one');
  for (const w of ['two', 'three', 'four', 'five']) {
    await box.press('Shift+Enter');
    await box.pressSequentially(w);
  }
  // Wait for the viewport to shrink and settle.
  await page.waitForTimeout(300);
  await page.evaluate((sid) => {
    window.__PR_MOCK__!.emitPrompt(sid, {
      promptId: 'p-after-grow',
      kind: 'permission',
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      toolUseId: 'tu-after-grow',
    });
  }, id);
  const ask = page.locator('.ask[data-kind="permission"][data-state="pending"]');
  await expect(ask.getByRole('button', { name: 'Allow', exact: true })).toBeInViewport();
  await expect.poll(gap).toBeLessThanOrEqual(2);
});

test('the log keeps following when a tall row shrinks and new rows arrive', async ({ page }) => {
  const id = await openChat(page, []);
  const log = page.getByTestId('chat-log');
  const gap = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const body = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n\n');
  await page.evaluate(
    ([sid, long]) => {
      const mk = (key: string, text: string) => ({ key, ts: Date.now(), kind: 'assistant', text });
      window.__PR_MOCK__!.pushItems(sid, [
        mk('a1', long),
        mk('a2', long),
        mk('tall', long + long),
      ] as never);
    },
    [id, body(10)] as const,
  );
  await expect(page.locator('.msg[data-key="tall"]')).toBeVisible();
  await expect.poll(gap).toBeLessThanOrEqual(2);
  // The tall row collapses to one line, then more rows follow.
  await page.evaluate(
    ([sid, k]) => {
      const mk = (key: string, text: string) => ({ key, ts: Date.now(), kind: 'assistant', text });
      window.__PR_MOCK__!.pushItems(sid, [mk(k, 'short now')] as never);
    },
    [id, 'tall'] as const,
  );
  await page.waitForTimeout(150);
  await page.evaluate(
    ([sid, long]) => {
      const mk = (key: string, text: string) => ({ key, ts: Date.now(), kind: 'assistant', text });
      window.__PR_MOCK__!.pushItems(sid, [mk('n1', long), mk('n2', 'the newest row')] as never);
    },
    [id, body(8)] as const,
  );
  await expect(page.locator('.msg[data-key="n2"]')).toBeInViewport();
  await expect.poll(gap).toBeLessThanOrEqual(2);
});
