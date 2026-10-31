import { expect, test, type Page } from '@playwright/test';

/**
 * Restart Patchroom: wait for idle (or interrupt), relaunch, reopen every open session with
 * `--resume`, drafts kept. The mock's page reload with `?persist` stands in for the relaunch.
 */

async function open(page: Page) {
  await page.goto('/?mock&persist&grid=100x30');
  await page.waitForFunction(() => !!window.__PR_STORE__?.getSnapshot().prefs);
  await page.evaluate(() => window.localStorage.clear());
  await page.goto('/?mock&persist&grid=100x30');
  await page.waitForFunction(() => !!window.__PR_STORE__?.getSnapshot().prefs);
  await page.evaluate(async () => {
    const m = window.__PR_MOCK__!;
    m.addSession({ id: 'a1', name: 'alpha', cwd: '/work/alpha', status: 'idle' });
    m.addSession({ id: 'b2', name: 'beta', cwd: '/work/beta', status: 'busy' });
    m.addSession({ id: 'c3', name: 'gamma', cwd: '/work/gamma', status: 'exited' });
    await window.__PR_STORE__!.refresh();
  });
}

test.describe('restart and resume', () => {
  test('waits for a busy session, then reopens every open one with drafts', async ({ page }) => {
    await open(page);
    await page.locator('[data-dm="a1"]').click();
    await page.getByTestId('composer-input').fill('half-written thought');
    await page.evaluate(() => window.__PR_MOCK__!.menuRestart());
    const dlg = page.getByTestId('restart-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('One is still working.');
    await dlg.getByTestId('restart-confirm').click();
    await expect(dlg.getByTestId('restart-waiting')).toBeVisible();
    expect(await page.evaluate(() => window.__PR_MOCK__!.restarts)).toEqual([]);
    // beta finishes its turn: the restart goes ahead on its own.
    await page.evaluate(() => window.__PR_MOCK__!.setStatus('b2', 'idle'));
    // After the relaunch: alpha and beta resumed, gamma (ended before) stays ended.
    await expect
      .poll(() =>
        page
          .evaluate(() => window.__PR_MOCK__?.resumes.map((r) => r.id).sort())
          .catch(() => undefined),
      )
      .toEqual(['a1', 'b2']);
    const states = await page.evaluate(() =>
      Object.fromEntries(window.__PR_MOCK__!.sessions().map((s) => [s.id, s.status])),
    );
    expect(states.c3).toBe('exited');
    // The open session and its draft come back.
    await expect(page.locator('[data-dm="a1"]')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('composer-input')).toHaveValue('half-written thought');
    await expect(page.locator('[data-hint="restart"]')).toContainText('reopened 2 sessions');
  });

  test('interrupt sends Esc to the chosen session and restarts at once', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__PR_MOCK__!.menuRestart());
    const dlg = page.getByTestId('restart-dialog');
    await dlg.getByTestId('restart-interrupt-b2').check();
    await expect(dlg.getByTestId('restart-confirm')).toHaveText('Interrupt and restart');
    // The mock does not end the turn on Esc by itself: record the write, then end it.
    await dlg.getByTestId('restart-confirm').click();
    await expect.poll(() => page.evaluate(() => window.__PR_MOCK__?.writes.b2?.[0])).toBe(27);
    await page.evaluate(() => window.__PR_MOCK__!.setStatus('b2', 'idle'));
    await expect
      .poll(() =>
        page
          .evaluate(() => window.__PR_MOCK__?.resumes.map((r) => r.id).sort())
          .catch(() => undefined),
      )
      .toEqual(['a1', 'b2']);
  });

  test('Cancel keeps everything running', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__PR_MOCK__!.menuRestart());
    await page.getByTestId('restart-dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('restart-dialog')).toHaveCount(0);
    await page.evaluate(() => window.__PR_MOCK__!.setStatus('b2', 'idle'));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__PR_MOCK__!.restarts)).toEqual([]);
  });

  test('all idle: restarts without asking', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__PR_MOCK__!.setStatus('b2', 'idle'));
    await page.evaluate(() => window.__PR_MOCK__!.menuRestart());
    await expect
      .poll(() =>
        page
          .evaluate(() => window.__PR_MOCK__?.resumes.map((r) => r.id).sort())
          .catch(() => undefined),
      )
      .toEqual(['a1', 'b2']);
  });
});
