import { expect, test, type Page } from '@playwright/test';
import { openFolder, watchErrors } from './helpers';

// Session parity item 2: a session live in another terminal opens as a read-only mirror.

const LIVE = 'fx-003';
const mock = <T>(page: Page, fn: () => T) => page.evaluate(fn);

async function openLiveMirror(page: Page): Promise<string> {
  await openFolder(page);
  await page.locator(`[data-fs-session="${LIVE}"]`).click();
  await page.getByRole('button', { name: 'Open anyway' }).click();
  const banner = page.getByTestId('mirror-banner');
  await expect(banner).toBeVisible();
  return mock(page, () => window.__PR_MOCK__!.sessions().at(-1)!.id);
}

test.describe('session parity: mirror', () => {
  test('opening a live session spawns nothing and shows the mirror banner', async ({ page }) => {
    const errs = watchErrors(page);
    const id = await openLiveMirror(page);
    const banner = page.getByTestId('mirror-banner');
    await expect(banner).toContainText('Open in another terminal (iTerm)');
    await expect(banner).toContainText('Read-only');
    // No process of Patchroom's own: nothing was spawned for this DM.
    expect(await mock(page, () => window.__PR_MOCK__!.spawns)).toEqual([]);
    expect(await mock(page, () => window.__PR_MOCK__!.folderOpens.map((o) => o.sessionId))).toEqual(
      [LIVE],
    );
    // The transcript tail still shows: the DM is a chat, not an empty box.
    await expect(page.getByTestId('chat')).toBeVisible();
    // The composer is off, with the reason in it.
    const box = page.getByTestId('composer-input');
    await expect(box).toBeDisabled();
    await expect(box).toHaveAttribute('placeholder', /Read-only: open in iTerm/);
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    // There is no terminal to show.
    await expect(page.getByRole('button', { name: 'Terminal' })).toBeDisabled();
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('view-label')).toHaveText('Chat');
    expect(await mock(page, () => window.__PR_MOCK__!.views)).toEqual([]);
    void id;
    expect(errs).toEqual([]);
  });

  test('an empty mirror says it is read-only and never offers Cmd+J', async ({ page }) => {
    await page.goto('/?mock&grid=100x30');
    await page.waitForFunction(() => !!window.__PR_STORE__ && !!window.__PR_MOCK__);
    await page.evaluate(async () => {
      const m = window.__PR_MOCK__!;
      const s = m.addSession({ id: 'bare', name: 'bare', cwd: '/work/bare', status: 'idle' });
      m.setMirror(s.id, { where: 'tmux', pid: 78, takeoverWhenClosed: false });
      await window.__PR_STORE__!.refresh();
      window.__PR_STORE__!.openDm(s.id);
    });
    const empty = page.getByTestId('chat-empty');
    await expect(empty).toContainText('read-only');
    await expect(empty).toContainText('tmux');
    await expect(empty).not.toContainText('Say something');
    await expect(empty.locator('kbd')).toHaveCount(0);
  });

  test('a send that reaches a mirror is refused and says why', async ({ page }) => {
    const id = await openLiveMirror(page);
    const result = await page.evaluate((sid) => window.__PR_STORE__!.sendText(sid, 'hello'), id);
    expect(result).toBe('mirror_readonly');
    await expect(page.getByTestId('composer-notice')).toContainText(
      'open in another terminal. Your message was not sent',
    );
    expect(await mock(page, () => window.__PR_MOCK__!.texts)).toEqual([]);
  });

  test('Take over when it closes resumes once, when the other process exits', async ({ page }) => {
    const errs = watchErrors(page);
    const id = await openLiveMirror(page);
    const arm = page.getByTestId('take-over-when-closed');
    await expect(arm).toHaveAttribute('aria-pressed', 'false');
    await arm.click();
    await expect(arm).toHaveAttribute('aria-pressed', 'true');
    expect(await mock(page, () => window.__PR_MOCK__!.takeoverArms)).toEqual([
      { id, enabled: true },
    ]);
    // Nothing runs while the other terminal lives.
    expect(await mock(page, () => window.__PR_MOCK__!.spawns)).toEqual([]);
    await page.evaluate((sid) => window.__PR_MOCK__!.closeMirror(sid), id);
    await expect(page.getByTestId('mirror-banner')).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeEnabled();
    // Exactly one process for the session.
    expect(await mock(page, () => window.__PR_MOCK__!.spawns)).toEqual([id]);
    expect(errs).toEqual([]);
  });

  test('arming can be undone', async ({ page }) => {
    const id = await openLiveMirror(page);
    const arm = page.getByTestId('take-over-when-closed');
    await arm.click();
    await arm.click();
    await expect(arm).toHaveAttribute('aria-pressed', 'false');
    expect(await mock(page, () => window.__PR_MOCK__!.takeoverArms)).toEqual([
      { id, enabled: true },
      { id, enabled: false },
    ]);
  });

  test('Take over now is refused while the other process lives, then works once it exits', async ({
    page,
  }) => {
    const id = await openLiveMirror(page);
    await page.getByTestId('take-over-now').click();
    await expect(page.getByTestId('mirror-detail')).toContainText('still running in iTerm');
    await expect(page.getByTestId('mirror-banner')).toBeVisible();
    expect(await mock(page, () => window.__PR_MOCK__!.spawns)).toEqual([]);
    // The other terminal closes (not armed): the banner stays until the user takes over.
    await page.evaluate((sid) => window.__PR_MOCK__!.closeMirror(sid), id);
    await expect(page.getByTestId('mirror-banner')).toBeVisible();
    await page.getByTestId('take-over-now').click();
    await expect(page.getByTestId('mirror-banner')).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeEnabled();
    expect(await mock(page, () => window.__PR_MOCK__!.spawns)).toEqual([id]);
  });

  test('a mirror started later (session:mirror) turns a running DM read-only', async ({ page }) => {
    await page.goto('/?mock&grid=100x30');
    await page.waitForFunction(() => !!window.__PR_STORE__ && !!window.__PR_MOCK__);
    const id = await page.evaluate(async () => {
      const m = window.__PR_MOCK__!;
      const s = m.addSession({ id: 'late', name: 'late', cwd: '/work/late', status: 'idle' });
      await window.__PR_STORE__!.refresh();
      window.__PR_STORE__!.openDm(s.id);
      return s.id;
    });
    await expect(page.getByTestId('composer-input')).toBeEnabled();
    await page.evaluate(
      (sid) =>
        window.__PR_MOCK__!.setMirror(sid, { where: 'tmux', pid: 77, takeoverWhenClosed: false }),
      id,
    );
    await expect(page.getByTestId('mirror-banner')).toContainText('(tmux)');
    await expect(page.getByTestId('composer-input')).toBeDisabled();
    await page.evaluate((sid) => window.__PR_MOCK__!.setMirror(sid, null), id);
    await expect(page.getByTestId('mirror-banner')).toHaveCount(0);
    await expect(page.getByTestId('composer-input')).toBeEnabled();
  });

  test('a folder row shows Checking until the live answer lands, never "not live"', async ({
    page,
  }) => {
    await openFolder(page);
    const row = page.locator('[data-fs-session="fx-001"]');
    await page.evaluate(() =>
      window.__PR_MOCK__!.patchFolderSession('atlas', 'fx-001', {
        liveElsewhere: false,
        liveState: 'checking',
      }),
    );
    await expect(row.locator('[data-chip="checking"]')).toHaveText('Checking');
    await expect(row.locator('[data-chip="live"]')).toHaveCount(0);
    await page.evaluate(() =>
      window.__PR_MOCK__!.patchFolderSession('atlas', 'fx-001', { liveState: 'free' }),
    );
    await expect(row.locator('[data-chip="checking"]')).toHaveCount(0);
  });
});
