import { expect, test } from '@playwright/test';
import { HOME, folderNames, openFolder, watchErrors } from './helpers';

const body = (page: import('@playwright/test').Page) => page.locator('[data-folder-body="atlas"]');
const activity = (page: import('@playwright/test').Page) =>
  page
    .locator('[data-folder-body="atlas"] > .fs-item .fs-row')
    .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.activity)));

test.describe('workspace: folder section order, noise and older sessions (checklist 16)', () => {
  test('needs-you DMs first, then busy, then the rest by last activity, newest first', async ({
    page,
  }) => {
    await openFolder(page, {
      dms: [
        { id: 'i1', name: 'idle-dm', cwd: HOME, sectionId: 'atlas', status: 'idle' },
        { id: 'b1', name: 'busy-dm', cwd: HOME, sectionId: 'atlas', status: 'busy' },
        { id: 'n1', name: 'needs-dm', cwd: HOME, sectionId: 'atlas', status: 'waiting' },
      ],
    });
    const order = await body(page)
      .locator('.row .nm')
      .evaluateAll((els) => els.slice(0, 5).map((e) => e.textContent));
    expect(order.slice(0, 3)).toEqual(['needs-dm', 'busy-dm', 'idle-dm']);
    // Sessions after the DMs run newest first.
    const at = await activity(page);
    expect(at.length).toBeGreaterThan(30);
    expect([...at].sort((a, b) => b - a)).toEqual(at);
    // A DM that starts needing you jumps above the busy one.
    await page.evaluate(() => window.__PR_MOCK__!.setStatus('b1', 'waiting', 'permission'));
    await page.evaluate(() => window.__PR_MOCK__!.setStatus('n1', 'idle'));
    await expect
      .poll(() =>
        body(page)
          .locator('.row .nm')
          .evaluateAll((els) => els.slice(0, 3).map((e) => e.textContent)),
      )
      .toEqual(['busy-dm', 'idle-dm', 'needs-dm']);
  });

  test('the order uses transcript activity, so a touched session rises to the top', async ({
    page,
  }) => {
    await openFolder(page);
    const oldest = (await body(page)
      .locator('> .fs-item .fs-row')
      .last()
      .getAttribute('data-fs-session'))!;
    expect((await folderNames(page)).length).toBeGreaterThan(10);
    await page.evaluate(
      (sid) => window.__PR_MOCK__!.patchFolderSession('atlas', sid, { lastActivity: Date.now() }),
      oldest,
    );
    await expect(body(page).locator('> .fs-item .fs-row').first()).toHaveAttribute(
      'data-fs-session',
      oldest,
    );
  });

  test('noise rows hide behind "Show N hidden"', async ({ page }) => {
    const errs = watchErrors(page);
    await openFolder(page);
    const toggle = body(page).getByRole('button', { name: 'Show 7 hidden' });
    await expect(toggle).toBeVisible();
    await expect(body(page).locator('.fs-row[data-hidden="true"]')).toHaveCount(0);
    const before = await body(page).locator('.fs-row').count();
    await toggle.click();
    await expect(body(page).locator('.fs-row[data-hidden="true"]').first()).toBeVisible();
    // Hidden rows older than X still fold into the Older list, so only some show in the main list.
    expect(await body(page).locator('.fs-row').count()).toBeGreaterThan(before);
    await expect(
      body(page).locator('.fs-row[data-hidden="true"] [data-chip="hidden"]').first(),
    ).toBeVisible();
    await expect(body(page).getByRole('button', { name: 'Hide 7 hidden' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await body(page).getByRole('button', { name: 'Hide 7 hidden' }).click();
    await expect(body(page).locator('.fs-row[data-hidden="true"]')).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('Hide and Unhide are in the row menu and never touch anything else', async ({ page }) => {
    await openFolder(page);
    const first = body(page).locator('> .fs-item .fs-row').first();
    const sid = (await first.getAttribute('data-fs-session'))!;
    const name = (await first.locator('[data-testid="fs-name"]').textContent())!;
    await first.click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['Open', 'Hide']);
    await page.getByRole('menuitem', { name: 'Hide' }).click();
    await expect(page.locator(`[data-fs-session="${sid}"]`)).toHaveCount(0);
    await expect(body(page).getByRole('button', { name: 'Show 8 hidden' })).toBeVisible();
    // Hiding is a list flag: no session was opened or created.
    const m = await page.evaluate(() => ({
      hides: window.__PR_MOCK__!.folderHides,
      opens: window.__PR_MOCK__!.folderOpens.length,
      sessions: window.__PR_MOCK__!.sessions().length,
    }));
    expect(m.hides).toEqual([{ sectionId: 'atlas', sessionId: sid, hidden: true }]);
    expect(m.opens).toBe(0);
    expect(m.sessions).toBe(0);
    // Show hidden, then Unhide it from the row menu.
    await body(page).getByRole('button', { name: 'Show 8 hidden' }).click();
    const row = page.locator(`[data-fs-session="${sid}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-testid="fs-name"]')).toHaveText(name);
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unhide' }).click();
    await expect(row.locator('[data-chip="hidden"]')).toHaveCount(0);
    await expect(body(page).getByRole('button', { name: 'Hide 7 hidden' })).toBeVisible();
  });

  test('the row menu opens from the keyboard', async ({ page }) => {
    await openFolder(page);
    const first = body(page).locator('> .fs-item .fs-row').first();
    await first.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Session actions' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Open' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('old sessions collapse into "Older than 14 days (N)" at the bottom', async ({ page }) => {
    await openFolder(page);
    const older = body(page).getByRole('button', { name: /^Older than 14 days \(21\)$/ });
    await expect(older).toBeVisible();
    await expect(older).toHaveAttribute('aria-expanded', 'false');
    // It is the last thing in the section.
    const last = await body(page).evaluate((el) => (el.lastElementChild as HTMLElement).className);
    expect(last).toContain('fs-toggle');
    const mainCount = await body(page).locator('.fs-row').count();
    await older.click();
    await expect(older).toHaveAttribute('aria-expanded', 'true');
    await expect(body(page).locator('.fs-older-list .fs-row')).toHaveCount(21);
    expect(await body(page).locator('.fs-row').count()).toBe(mainCount + 21);
    // Every row in the dropdown really is older than 14 days.
    const ages = await body(page)
      .locator('.fs-older-list .fs-row')
      .evaluateAll((els) =>
        els.map((e) => Date.now() - Number((e as HTMLElement).dataset.activity)),
      );
    expect(Math.min(...ages)).toBeGreaterThan(14 * 86_400_000);
    await older.click();
    await expect(body(page).locator('.fs-older-list')).toHaveCount(0);
  });

  test('X is editable from the section menu and re-splits the list', async ({ page }) => {
    await openFolder(page);
    await page.locator('.side [data-group="atlas"] .sec-h').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Older than 14 days...' }).click();
    const dlg = page.getByRole('dialog', { name: 'Older than days' });
    await expect(dlg.getByLabel('Days')).toHaveValue('14');
    await dlg.getByLabel('Days').fill('0');
    await expect(dlg.getByRole('button', { name: 'Save' })).toBeDisabled();
    await dlg.getByLabel('Days').fill('3');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toHaveCount(0);
    const older = body(page).locator('.fs-older');
    await expect(older).toContainText('Older than 3 days (');
    const n3 = Number(/\((\d+)\)/.exec((await older.textContent())!)![1]);
    expect(n3).toBeGreaterThan(21);
    expect(await page.evaluate(() => window.__PR_MOCK__!.archiveCalls)).toEqual([
      { id: 'atlas', days: 3 },
    ]);
    expect(await page.evaluate(() => window.__PR_MOCK__!.sections()[0].archiveDays)).toBe(3);
    // And larger: nothing is older than 365 days in the fixture.
    await page.locator('.side [data-group="atlas"] .sec-h').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Older than 3 days...' }).click();
    const dlg2 = page.getByRole('dialog', { name: 'Older than days' });
    await dlg2.getByLabel('Days').fill('365');
    await dlg2.getByLabel('Days').press('Enter');
    await expect(body(page).locator('.fs-older')).toHaveCount(0);
  });

  test('older sessions stay reachable from Cmd+K and open from there', async ({ page }) => {
    await openFolder(page);
    const sid = await page.evaluate(() => {
      const rows = window.__PR_MOCK__!.folderRows('atlas').filter((r) => !r.hidden);
      return rows.sort((a, b) => Number(a.lastActivity) - Number(b.lastActivity))[0].sessionId;
    });
    const name = await page.evaluate(
      (id) => window.__PR_MOCK__!.folderRows('atlas').find((r) => r.sessionId === id)!.name,
      sid,
    );
    await page.keyboard.press('Meta+k');
    await page.keyboard.type(name.slice(0, 12));
    const opt = page.getByRole('option', { name: new RegExp(name.slice(0, 12)) }).first();
    await expect(opt).toBeVisible();
    await expect(page.locator('.palette__item[data-folder-session]').first()).toContainText(
      'Not open',
    );
    // The hidden noise rows never show up.
    const box = page.getByRole('combobox', { name: 'Jump to a DM' });
    await box.fill('(no prompt)');
    await expect(page.getByRole('option')).toHaveCount(0);
    await box.fill(name);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toHaveCount(0);
    const opens = await page.evaluate(() =>
      window.__PR_MOCK__!.folderOpens.map((o) => o.sessionId),
    );
    expect(opens).toHaveLength(1);
    await expect(page.locator('.side [data-group="atlas"] .row[data-dm]')).toHaveCount(1);
  });

  test('an empty Cmd+K lists open DMs only, not every discovered session', async ({ page }) => {
    await openFolder(page, { dms: [{ id: 'a', name: 'alpha', cwd: HOME, sectionId: 'atlas' }] });
    await page.keyboard.press('Meta+k');
    await expect(page.getByRole('option')).toHaveCount(1);
  });
});
