import { expect, test } from '@playwright/test';
import { HOME, openChat, openFolder, watchErrors } from './helpers';

// Session parity: delivery copy is true, the mirror composer says why it is off, and a failed
// live check offers "Open anyway" behind a two-process warning.

const FREE = 'fx-001';

test.describe('session parity: truthful delivery copy', () => {
  test('terminal-wait banner never claims messages wait; the draft stays and does not auto-send', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await page.evaluate((sid) => window.__PR_MOCK__!.setTerminalDialog(sid, true, 'trust'), id);
    const banner = page.getByTestId('terminal-wait-banner');
    await expect(banner).toBeVisible();
    await expect(banner).not.toContainText(/wait until/i);
    await expect(banner).toContainText('stays in the box until you send it again');
    const box = page.getByTestId('composer-input');
    await box.fill('hello');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('composer-notice')).toContainText('stays in the box');
    await expect(page.getByTestId('composer-hint')).toContainText('Enter keeps your message here');
    // Closing the dialog does not send by itself.
    await page.evaluate((sid) => window.__PR_MOCK__!.setTerminalDialog(sid, false), id);
    await expect(page.getByTestId('composer-hint')).toHaveText(
      'Enter sends. Shift+Enter adds a line.',
    );
    expect(await page.evaluate(() => window.__PR_MOCK__!.texts)).toEqual([]);
    await expect(box).toHaveValue('hello');
    await expect(page.getByTestId('composer-hint')).toHaveText(
      'Enter sends. Shift+Enter adds a line.',
    );
  });
});

test.describe('session parity: mirror composer state', () => {
  test('a mirror with a draft shows the reason above the box and no send hint', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await page.getByTestId('composer-input').fill('my draft');
    await page.evaluate(
      (sid) =>
        window.__PR_MOCK__!.setMirror(sid, { where: 'iTerm', pid: 9, takeoverWhenClosed: false }),
      id,
    );
    const box = page.getByTestId('composer-input');
    await expect(box).toBeDisabled();
    await expect(box).toHaveValue('my draft');
    const reason = page.getByTestId('composer-reason');
    await expect(reason).toBeVisible();
    await expect(reason).toContainText('Read-only: open in iTerm');
    await expect(reason).toContainText('draft stays here and is not sent');
    // The reason sits above the box.
    const [r, b] = await Promise.all([reason.boundingBox(), box.boundingBox()]);
    expect(r!.y + r!.height).toBeLessThanOrEqual(b!.y);
    const hint = page.getByTestId('composer-hint');
    await expect(hint).toHaveText('Read-only. Sending is off.');
    await expect(hint).not.toContainText('Enter sends');
    // Leaving the mirror restores the send hint and drops the reason.
    await page.evaluate((sid) => window.__PR_MOCK__!.setMirror(sid, null), id);
    await expect(page.getByTestId('composer-reason')).toHaveCount(0);
    await expect(hint).toHaveText('Enter sends. Shift+Enter adds a line.');
  });

  test('an empty mirror composer says nothing typed is sent', async ({ page }) => {
    const id = await openChat(page, []);
    await page.evaluate(
      (sid) =>
        window.__PR_MOCK__!.setMirror(sid, { where: 'tmux', pid: 9, takeoverWhenClosed: false }),
      id,
    );
    await expect(page.getByTestId('composer-reason')).toContainText(
      'Read-only: open in tmux. Nothing you type here is sent.',
    );
  });
});

test.describe('session parity: check failed', () => {
  test('a folder open whose check fails shows why, spawns nothing, and offers Open anyway', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openFolder(page, { home: HOME });
    await page.evaluate(() => {
      window.__PR_MOCK__!.failNextCheck = 'could not check: claude agents timed out after 3 s';
    });
    await page.locator(`[data-fs-session="${FREE}"]`).click();
    const dlg = page.getByTestId('check-failed');
    await expect(dlg).toBeVisible();
    await expect(page.getByTestId('check-failed-reason')).toContainText('timed out after 3 s');
    const warn = page.getByTestId('check-failed-warning');
    await expect(warn).toContainText('second process');
    expect(await page.evaluate(() => window.__PR_MOCK__!.spawns)).toEqual([]);
    expect(await page.evaluate(() => window.__PR_MOCK__!.sessions().length)).toBe(0);
    // Cancel leaves nothing behind.
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toHaveCount(0);
    expect(await page.evaluate(() => window.__PR_MOCK__!.spawns)).toEqual([]);
    // Try again, then open anyway.
    await page.evaluate(() => {
      window.__PR_MOCK__!.failNextCheck = 'could not check: claude agents failed';
    });
    await page.locator(`[data-fs-session="${FREE}"]`).click();
    await expect(dlg).toBeVisible();
    await page.getByTestId('open-anyway').click();
    await expect(dlg).toHaveCount(0);
    expect(await page.evaluate(() => window.__PR_MOCK__!.openAnyways)).toEqual([FREE]);
    expect(await page.evaluate(() => window.__PR_MOCK__!.spawns.length)).toBe(1);
    expect(errs).toEqual([]);
  });

  test('a resume whose check fails keeps the exited DM and offers Open anyway', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await page.evaluate((sid) => window.__PR_MOCK__!.exit(sid, 0), id);
    await page.evaluate(() => {
      window.__PR_MOCK__!.failNextCheck = 'could not check: claude agents is not installed';
    });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByTestId('check-failed')).toContainText('not installed');
    expect(await page.evaluate(() => window.__PR_MOCK__!.resumes.length)).toBe(0);
    await expect(page.getByTestId('exit-bar')).toBeVisible();
    await page.getByTestId('open-anyway').click();
    await expect(page.getByTestId('check-failed')).toHaveCount(0);
    expect(await page.evaluate(() => window.__PR_MOCK__!.resumes.length)).toBe(1);
  });
});
