import { expect, test, type Page } from '@playwright/test';
import { dragTo, openFolder, watchErrors } from './helpers';

const body = (page: Page) => page.locator('[data-folder-body="atlas"]');
const LIVE = 'fx-003';

test.describe('workspace: folder section live behavior (checklist 16)', () => {
  test('a session started outside Patchroom appears within 2 s', async ({ page }) => {
    const errs = watchErrors(page);
    await openFolder(page);
    const before = await body(page).locator('.fs-row').count();
    await page.evaluate(() =>
      window.__PR_MOCK__!.addFolderSession('atlas', { name: 'Started in iTerm just now' }),
    );
    const row = body(page).locator('.fs-row', { hasText: 'Started in iTerm just now' });
    await expect(row).toBeVisible({ timeout: 2000 });
    await expect(row.locator('.fs-age')).toHaveText('now');
    // Newest first: it is the top row.
    await expect(body(page).locator('> .fs-item .fs-row').first()).toContainText(
      'Started in iTerm',
    );
    expect(await body(page).locator('.fs-row').count()).toBe(before + 1);
    expect(errs).toEqual([]);
  });

  test('a burst of folder:changed events costs one read, not one per event', async ({ page }) => {
    await openFolder(page);
    const before = await page.evaluate(() => window.__PR_MOCK__!.folderCalls.length);
    await page.evaluate(() => {
      for (let i = 0; i < 25; i++) window.__PR_MOCK__!.folderChanged('atlas');
    });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.__PR_MOCK__!.folderCalls.length);
    expect(after - before).toBeLessThanOrEqual(2);
    expect(after - before).toBeGreaterThanOrEqual(1);
  });

  test('a rename and a new live process show without a reload', async ({ page }) => {
    await openFolder(page);
    const row = page.locator('[data-fs-session="fx-001"]');
    await expect(row.locator('[data-chip="live"]')).toHaveCount(0);
    await page.evaluate(() =>
      window.__PR_MOCK__!.patchFolderSession('atlas', 'fx-001', {
        name: 'Renamed with /rename',
        nameSource: 'custom-title',
        liveElsewhere: true,
      }),
    );
    await expect(row.getByTestId('fs-name')).toHaveText('Renamed with /rename');
    await expect(row.locator('[data-chip="live"]')).toBeVisible();
    await page.evaluate(() =>
      window.__PR_MOCK__!.patchFolderSession('atlas', 'fx-001', { liveElsewhere: false }),
    );
    await expect(row.locator('[data-chip="live"]')).toHaveCount(0);
  });

  test('a session live in another terminal asks first, with no native dialog', async ({ page }) => {
    const errs = watchErrors(page);
    let native = 0;
    page.on('dialog', (d) => {
      native += 1;
      void d.dismiss();
    });
    await openFolder(page);
    const row = page.locator(`[data-fs-session="${LIVE}"]`);
    await expect(row.locator('[data-chip="live"]')).toHaveText('Live elsewhere');
    await row.click();
    const ask = page.getByTestId('fs-confirm');
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('running in another terminal');
    // The safe choice has the focus.
    await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await page.evaluate(() => window.__PR_MOCK__!.folderOpens.length)).toBe(0);
    // Esc cancels.
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    expect(await page.evaluate(() => window.__PR_MOCK__!.folderOpens.length)).toBe(0);
    // Cancel button too.
    await row.click();
    await page.getByTestId('fs-confirm').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('fs-confirm')).toHaveCount(0);
    // Confirming opens it.
    await row.click();
    await page.getByRole('button', { name: 'Open anyway' }).click();
    await expect(page.locator('.side [data-group="atlas"] .row[data-dm]')).toHaveCount(1);
    expect(
      await page.evaluate(() => window.__PR_MOCK__!.folderOpens.map((o) => o.sessionId)),
    ).toEqual([LIVE]);
    expect(native).toBe(0);
    expect(errs).toEqual([]);
  });

  test('the row menu Open asks first for a live session as well', async ({ page }) => {
    await openFolder(page);
    await page.locator(`[data-fs-session="${LIVE}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open' }).click();
    await expect(page.getByTestId('fs-confirm')).toBeVisible();
    expect(await page.evaluate(() => window.__PR_MOCK__!.folderOpens.length)).toBe(0);
  });

  test('Cmd+K asks first for a live session too: Esc backs out, Enter confirms', async ({
    page,
  }) => {
    await openFolder(page);
    const name = await page.evaluate(
      (id) => window.__PR_MOCK__!.folderRows('atlas').find((r) => r.sessionId === id)!.name,
      LIVE,
    );
    await page.keyboard.press('Meta+k');
    await page.getByRole('combobox', { name: 'Jump to a DM' }).fill(name);
    await expect(page.locator('.palette__item[data-folder-session]').first()).toContainText(
      'Live elsewhere',
    );
    await page.keyboard.press('Enter');
    const ask = page.getByRole('group', { name: 'Confirm open' });
    await expect(ask).toBeVisible();
    expect(await page.evaluate(() => window.__PR_MOCK__!.folderOpens.length)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toHaveCount(0);
    expect(
      await page.evaluate(() => window.__PR_MOCK__!.folderOpens.map((o) => o.sessionId)),
    ).toEqual([LIVE]);
  });

  test('dragging a DM from another folder in shows a folder chip and restarts nothing', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    // The small fixture keeps both groups on screen, so the real mouse can reach them.
    await openFolder(page, {
      home: '/tmp/small-folder',
      dms: [
        { id: 'k1', name: 'knowfirst', cwd: '/Users/me/code/knowfirst', status: 'busy' },
        { id: 'in1', name: 'inside', cwd: '/tmp/small-folder/packages/api', sectionId: 'atlas' },
      ],
    });
    const row = page.locator('.side .row[data-dm="k1"]');
    await expect(row.getByTestId('folder-chip')).toHaveCount(0);
    await dragTo(page, row, page.locator('.side [data-group="atlas"] .sec-h'));
    const moved = page.locator('.side [data-group="atlas"] .row[data-dm="k1"]');
    await expect(moved).toBeVisible();
    await expect(moved.getByTestId('folder-chip')).toHaveText('knowfirst');
    await expect(moved.getByTestId('folder-chip')).toHaveAttribute(
      'title',
      /\/Users\/me\/code\/knowfirst/,
    );
    // A DM inside the folder wears no chip.
    await expect(page.locator('.side .row[data-dm="in1"]').getByTestId('folder-chip')).toHaveCount(
      0,
    );
    // Filing only: same session, same cwd, still running, nothing resumed or spawned.
    const m = await page.evaluate(() => ({
      s: window.__PR_MOCK__!.sessions().find((x) => x.id === 'k1')!,
      resumes: window.__PR_MOCK__!.resumes.length,
      count: window.__PR_MOCK__!.sessions().length,
    }));
    expect(m.s.cwd).toBe('/Users/me/code/knowfirst');
    expect(m.s.sectionId).toBe('atlas');
    expect(m.s.status).toBe('busy');
    expect(m.resumes).toBe(0);
    expect(m.count).toBe(2);
    // Dragging it back out drops the chip.
    await dragTo(page, moved, page.locator('.side [data-group="__default__"] .sec-h'));
    await expect(page.locator('.side [data-group="__default__"] .row[data-dm="k1"]')).toBeVisible();
    await expect(page.locator('.side .row[data-dm="k1"]').getByTestId('folder-chip')).toHaveCount(
      0,
    );
    expect(errs).toEqual([]);
  });

  test('moving a DM in through its context menu shows the chip as well', async ({ page }) => {
    await openFolder(page, {
      dms: [{ id: 'k1', name: 'knowfirst', cwd: '/Users/me/code/knowfirst' }],
    });
    await page.locator('.side .row[data-dm="k1"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to atlas' }).click();
    await expect(
      page.locator('.side [data-group="atlas"] .row[data-dm="k1"] [data-testid="folder-chip"]'),
    ).toHaveText('knowfirst');
  });

  test('a starred folder DM does not also show as a lazy row', async ({ page }) => {
    await openFolder(page);
    await body(page).locator('.fs-row').first().click();
    await expect(page.locator('.side [data-group="atlas"] .row[data-dm]')).toHaveCount(1);
    const dmId = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0].id);
    const total = await body(page).locator('.fs-row').count();
    await page.evaluate((id) => window.__PR_STORE__!.setFlags(id, { starred: true }), dmId);
    await expect(page.locator('.side [data-group="__starred__"] .row[data-dm]')).toHaveCount(1);
    expect(await body(page).locator('.fs-row').count()).toBe(total);
  });

  test('ending forgetting a DM returns its session to the list as a row', async ({ page }) => {
    await openFolder(page);
    const first = body(page).locator('.fs-row').first();
    const sid = (await first.getAttribute('data-fs-session'))!;
    await first.click();
    await expect(page.locator(`[data-fs-session="${sid}"]`)).toHaveCount(0);
    const dmId = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0].id);
    await page.evaluate((id) => window.__PR_STORE__!.deleteSession(id), dmId);
    await expect(page.locator(`[data-fs-session="${sid}"]`)).toBeVisible();
    await expect(page.locator('.side [data-group="atlas"] .row[data-dm]')).toHaveCount(0);
  });

  test('deleting a folder section sends its DMs to Direct messages', async ({ page }) => {
    await openFolder(page);
    await body(page).locator('.fs-row').first().click();
    await expect(page.locator('.side [data-group="atlas"] .row[data-dm]')).toHaveCount(1);
    await page.locator('.side [data-group="atlas"] .sec-h').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete section' }).click();
    await expect(page.locator('.side [data-group="atlas"]')).toHaveCount(0);
    await expect(page.locator('.side [data-group="__default__"] .row[data-dm]')).toHaveCount(1);
  });

  test('collapsing a folder section hides its rows and keeps them on return', async ({ page }) => {
    await openFolder(page);
    await page.locator('.side [data-group="atlas"] .sec-h').click();
    await expect(body(page)).toHaveCount(0);
    await page.locator('.side [data-group="atlas"] .sec-h').click();
    await expect(body(page).locator('.fs-row').first()).toBeVisible();
  });
});
