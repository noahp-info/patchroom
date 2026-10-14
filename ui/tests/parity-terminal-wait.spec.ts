import { expect, test, type Page } from '@playwright/test';
import { openChat, peekWrites, watchErrors } from './helpers';

// Session parity items 3 and 4: terminal-only dialogs surface in chat, and the composer never
// swallows input.

const sends = (page: Page) => page.evaluate(() => window.__PR_MOCK__!.sends);
const texts = (page: Page) => page.evaluate(() => window.__PR_MOCK__!.texts.map((t) => t.text));
const dialog = (page: Page, id: string, on: boolean, reason?: string) =>
  page.evaluate(([sid, v, r]) => window.__PR_MOCK__!.setTerminalDialog(sid, v, r), [
    id,
    on,
    reason,
  ] as [string, boolean, string | undefined]);

test.describe('session parity: terminal-wait banner', () => {
  test('a terminal-only dialog shows the needs-you banner within 2 s', async ({ page }) => {
    const errs = watchErrors(page);
    const id = await openChat(page, []);
    const banner = page.getByTestId('terminal-wait-banner');
    await expect(banner).toHaveCount(0);
    await dialog(page, id, true);
    await expect(banner).toBeVisible({ timeout: 2000 });
    await expect(banner).toContainText('Claude is showing something in the terminal');
    await expect(banner.getByRole('button', { name: /Show terminal/ })).toBeVisible();
    // Sidebar and the title bar count it as needs-you.
    await expect(page.locator('.side .row .bdg.needs').first()).toBeVisible();
    await expect(page.locator('.tb-act b')).toHaveText('1');
    // The wait ends: the banner goes.
    await dialog(page, id, false);
    await expect(banner).toHaveCount(0);
    await expect(page.locator('.tb-act b')).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('the CLI reason shows when it is more than "dialog open"', async ({ page }) => {
    const id = await openChat(page, []);
    await dialog(page, id, true, 'trust this folder');
    await expect(page.getByTestId('terminal-wait-banner')).toContainText('trust this folder');
  });

  test('Show terminal flips to the terminal; Esc reaches the TUI and returns to chat', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await dialog(page, id, true);
    await page.getByTestId('open-terminal').click();
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await expect(page.getByTestId('term-note')).toContainText('Answer it here');
    await page.keyboard.press('Escape');
    // Esc went to the PTY (the TUI closes its dialog), then the view returned.
    await expect(page.getByTestId('view-label')).toHaveText('Chat');
    expect(await peekWrites(page, id)).toContain('27');
    await expect(page.getByTestId('term-note')).toHaveCount(0);
  });

  test('Cmd+J flips to the terminal and back while the dialog is up', async ({ page }) => {
    const id = await openChat(page, []);
    await dialog(page, id, true);
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('view-label')).toHaveText('Chat');
    await expect(page.getByTestId('terminal-wait-banner')).toBeVisible();
  });

  test('Esc in a terminal opened by hand does not leave it', async ({ page }) => {
    await openChat(page, []);
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await page.keyboard.press('Escape');
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
  });
});

test.describe('session parity: the composer never swallows input', () => {
  test('Enter during a dialog keeps the draft, writes nothing, and offers Open terminal', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await dialog(page, id, true);
    const box = page.getByTestId('composer-input');
    await box.fill('please continue');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('please continue');
    expect(await sends(page)).toEqual([]);
    expect(await texts(page)).toEqual([]);
    expect(await peekWrites(page, id)).toBe('');
    const note = page.getByTestId('composer-notice');
    await expect(note).toContainText('Claude is showing something in the terminal');
    await expect(note).toContainText('stays in the box');
    await note.getByRole('button', { name: 'Open terminal' }).click();
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await page.keyboard.press('Meta+j');
    // The dialog is answered: the kept draft sends.
    await dialog(page, id, false);
    await expect(page.getByTestId('composer-notice')).toHaveCount(0);
    await expect(box).toHaveValue('please continue');
    await page.keyboard.press('Enter');
    await expect.poll(() => texts(page)).toEqual(['please continue']);
    await expect(box).toHaveValue('');
  });

  test('a send that races the dialog is refused by the backend and the draft comes back', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    // The dialog is up in the backend; the UI has not heard yet (no event).
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.sessions().find((s) => s.id === sid)!.terminalWait = {
        reason: 'dialog open',
        since: Date.now(),
      };
    }, id);
    const box = page.getByTestId('composer-input');
    await box.fill('ship it');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-notice')).toContainText(
      'Claude is showing something in the terminal',
    );
    await expect(box).toHaveValue('ship it');
    expect((await sends(page))[0]).toMatchObject({ text: 'ship it', outcome: 'blocked_dialog' });
    expect(await texts(page)).toEqual([]);
    expect(await peekWrites(page, id)).toBe('');
  });

  test('text sent while claude is busy queues and says so', async ({ page }) => {
    const id = await openChat(page, []);
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'busy'), id);
    const box = page.getByTestId('composer-input');
    await box.fill('after this');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-notice')).toContainText('Queued');
    await expect(box).toHaveValue('');
    expect((await sends(page))[0]).toMatchObject({ outcome: 'queued' });
    // The queued text still reaches the transcript.
    await expect(page.locator('.msg[data-kind="user"]')).toContainText('after this');
  });

  test('a sent message with no user item within 3 s says why', async ({ page }) => {
    await openChat(page, []);
    await page.evaluate(() => {
      window.__PR_MOCK__!.autoEcho = false;
    });
    const box = page.getByTestId('composer-input');
    await box.fill('hello?');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-notice')).toHaveCount(0);
    await expect(page.getByTestId('composer-notice')).toContainText(
      'Claude has not shown your message yet',
      { timeout: 5000 },
    );
    await expect(
      page.getByTestId('composer-notice').getByRole('button', { name: 'Open terminal' }),
    ).toBeVisible();
    // It shows up late: the notice clears.
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.pushItems(m.sessions()[0].id, [
        { key: 'late-user', ts: Date.now(), kind: 'user', text: 'hello?', images: [] },
      ]);
    });
    await expect(page.getByTestId('composer-notice')).toHaveCount(0);
  });

  test('a normal send shows its user item at once and leaves no notice', async ({ page }) => {
    await page.clock.install();
    await openChat(page, []);
    await page.clock.pauseAt(new Date(Date.now() + 5_000));
    await page.getByTestId('composer-input').fill('hi');
    await page.keyboard.press('Enter');
    await page.clock.runFor(100);
    await expect(page.locator('.msg[data-kind="user"]')).toContainText('hi');
    await page.clock.runFor(3300);
    await expect(page.getByTestId('composer-notice')).toHaveCount(0);
  });
});
