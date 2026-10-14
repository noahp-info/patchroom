import { expect, test, type Page } from '@playwright/test';
import { openChat, peekWrites, watchErrors } from './helpers';

// Session parity item 5: slash commands that open TUI panels fall back to the terminal.

// The list in docs/gauntlet/SESSION-PARITY-BAR.md, item 5.
const INTERACTIVE = [
  'usage',
  'config',
  'model',
  'status',
  'agents',
  'mcp',
  'resume',
  'permissions',
  'hooks',
  'memory',
  'doctor',
  'context',
  'cost',
  'login',
  'logout',
  'ide',
  'theme',
  'vim',
  'export',
  'help',
  'plugin',
  'bashes',
  'todos',
  'output-style',
  'statusline',
];

const label = (page: Page) => page.getByTestId('view-label');
const send = async (page: Page, text: string) => {
  const box = page.getByTestId('composer-input');
  await box.fill(text);
  await page.keyboard.press('Enter');
};

test.describe('session parity: slash commands fall back to the terminal', () => {
  test('every interactive command opens the terminal with a note, and Esc returns', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openChat(page, []);
    for (const name of INTERACTIVE) {
      await send(page, `/${name}`);
      await expect(label(page), `/${name} flips to the terminal`).toHaveText('Terminal');
      await expect(page.getByTestId('term-note')).toContainText(`/${name} opens in the terminal`);
      await page.keyboard.press('Escape');
      await expect(label(page), `Esc leaves /${name}`).toHaveText('Chat');
    }
    // Every one of them reached claude as text first.
    expect(await page.evaluate(() => window.__PR_MOCK__!.texts.map((t) => t.text))).toEqual(
      INTERACTIVE.map((n) => `/${n}`),
    );
    expect(errs).toEqual([]);
  });

  test('a command with arguments still counts, and the case does not matter', async ({ page }) => {
    await openChat(page, []);
    await send(page, '/Model opus');
    await expect(label(page)).toHaveText('Terminal');
  });

  test('Cmd+J returns from the panel', async ({ page }) => {
    await openChat(page, []);
    await send(page, '/usage');
    await expect(label(page)).toHaveText('Terminal');
    await page.keyboard.press('Meta+j');
    await expect(label(page)).toHaveText('Chat');
    await expect(page.getByTestId('term-note')).toHaveCount(0);
  });

  test('Esc reaches the TUI as well as leaving', async ({ page }) => {
    const id = await openChat(page, []);
    await send(page, '/config');
    await expect(label(page)).toHaveText('Terminal');
    await page.keyboard.press('Escape');
    await expect(label(page)).toHaveText('Chat');
    expect(await peekWrites(page, id)).toContain('27');
  });

  test('"Back to chat" on the note returns too', async ({ page }) => {
    await openChat(page, []);
    await send(page, '/mcp');
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(label(page)).toHaveText('Chat');
  });

  test('an unknown command with no transcript item flips after 2 s while the PTY repaints', async ({
    page,
  }) => {
    await openChat(page, []);
    await send(page, '/frobnicate now');
    await page.waitForTimeout(1200);
    await expect(label(page)).toHaveText('Chat');
    await expect(label(page)).toHaveText('Terminal', { timeout: 3000 });
    await expect(page.getByTestId('term-note')).toContainText('/frobnicate');
    await page.keyboard.press('Escape');
    await expect(label(page)).toHaveText('Chat');
  });

  test('an unknown command that produces a transcript item stays in chat', async ({ page }) => {
    await openChat(page, []);
    await send(page, '/review-pr 12');
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.pushItems(m.sessions()[0].id, [
        { key: 'slash-1', ts: Date.now(), kind: 'user', text: '/review-pr 12', images: [] },
      ]);
    });
    await page.waitForTimeout(2600);
    await expect(label(page)).toHaveText('Chat');
  });

  test('an unknown command while the PTY stays quiet stays in chat', async ({ page }) => {
    await openChat(page, []);
    await page.evaluate(() => {
      window.__PR_MOCK__!.repaintOnSlash = false;
    });
    await send(page, '/quiet');
    await page.waitForTimeout(2600);
    await expect(label(page)).toHaveText('Chat');
  });

  test('a plain message and a pasted path never trigger the fallback', async ({ page }) => {
    await openChat(page, []);
    await send(page, 'what does /usage do?');
    await send(page, '/Users/me/code/x.ts is the file');
    await page.waitForTimeout(2600);
    await expect(label(page)).toHaveText('Chat');
  });

  test('a command queued behind a busy turn does not flip the view', async ({ page }) => {
    await openChat(page, []);
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.setStatus(m.sessions()[0].id, 'busy');
    });
    await send(page, '/usage');
    await expect(page.getByTestId('composer-notice')).toContainText('Queued');
    await expect(label(page)).toHaveText('Chat');
  });
});
