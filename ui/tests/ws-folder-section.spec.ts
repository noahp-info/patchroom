import { expect, test } from '@playwright/test';
import { HOME, chooseNew, folderNames, openFolder, openSeeded, watchErrors } from './helpers';

const rows = (page: import('@playwright/test').Page) =>
  page.locator('.side [data-folder-body="atlas"] .fs-row');

test.describe('workspace: folder sections, creation and discovery (checklist 16)', () => {
  test('"New section from folder..." uses the folder picker and lists its sessions', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openSeeded(page, []);
    await page.evaluate((home) => (window.__PR_MOCK__!.pickResult = home), HOME);
    await chooseNew(page, 'New section from folder...');
    const sec = page.locator('.side [data-kind="section"]', { hasText: 'atlas' });
    await expect(sec).toBeVisible();
    await expect(sec.locator('.sec-h')).toHaveAttribute('title', HOME);
    await expect(sec.locator('.fs-row').first()).toBeVisible();
    const made = await page.evaluate(() => window.__PR_MOCK__!.folderCreates);
    expect(made).toEqual([{ path: HOME, name: undefined }]);
    // No name form: the folder names the section.
    await expect(page.getByLabel('Section name')).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('a cancelled picker adds nothing', async ({ page }) => {
    await openSeeded(page, []);
    await chooseNew(page, 'New section from folder...');
    await expect(page.locator('.side [data-kind="section"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__PR_MOCK__!.folderCreates)).toEqual([]);
    await expect(page.getByLabel('Section name')).toHaveCount(0);
  });

  test('a plain section keeps working beside a folder section', async ({ page }) => {
    await openSeeded(page, [{ id: 'a', name: 'alpha' }], {
      sections: [{ id: 'plain', name: 'Plain' }],
    });
    await page.evaluate(() => {
      window.__PR_MOCK__!.addSection({
        id: 'atlas',
        name: 'atlas',
        folder: '/Users/me/code/atlas',
      });
      return window.__PR_STORE__!.refresh();
    });
    await expect(page.locator('.side [data-group="plain"] .fs-row')).toHaveCount(0);
    await expect(page.locator('.side [data-group="atlas"] .fs-row').first()).toBeVisible();
    await expect(page.locator('.side [data-group="plain"] .sec-h svg.i')).toHaveCount(1); // chevron only
  });

  test('lists one-line rows: relative time, a branch chip only off the folder branch, a worktree glyph', async ({
    page,
  }) => {
    await openFolder(page);
    const first = rows(page).first();
    await expect(first.locator('.fs-age')).toHaveText(/^\d+m$/);
    // The first session is on the folder's own branch: no chip, no glyph, no path.
    await expect(first.locator('[data-chip="branch"]')).toHaveCount(0);
    await expect(first.getByTestId('wt-glyph')).toHaveCount(0);
    // A session on another branch wears the chip.
    await expect(
      page.locator('[data-chip="branch"]', { hasText: 'feat/billing' }).first(),
    ).toBeVisible();
    // A worktree under .claude/worktrees wears the glyph. Its auto-named branch stays in the card.
    const wt = page.locator('[data-fs-session]', {
      has: page.getByLabel('Worktree: .claude/worktrees/fix-login'),
    });
    await expect(wt.first()).toBeVisible();
    await expect(wt.first().locator('[data-chip="branch"]')).toHaveCount(0);
    // A linked worktree outside the folder wears it too, and its own branch is a real difference.
    const linked = page.locator('[data-fs-session]', {
      has: page.getByLabel('Worktree: ../atlas-release'),
    });
    await expect(linked.first().locator('[data-chip="branch"]')).toHaveText('release/2.4');
    // A subfolder session is plain: the path lives in the hover card, never on the row.
    await expect(page.locator('.side [data-chip="path"], .side .fs-l2')).toHaveCount(0);
    // Every row is one line.
    const heights = await rows(page).evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
    expect(heights.length).toBeGreaterThan(10);
    expect(Math.max(...heights)).toBeLessThanOrEqual(32);
  });

  test('a row is not a process: nothing spawns until it opens', async ({ page }) => {
    await openFolder(page);
    const m = await page.evaluate(() => ({
      sessions: window.__PR_MOCK__!.sessions().length,
      resumes: window.__PR_MOCK__!.resumes.length,
      opens: window.__PR_MOCK__!.folderOpens.length,
    }));
    expect(m).toEqual({ sessions: 0, resumes: 0, opens: 0 });
    await expect(rows(page).first().locator('.dot')).toHaveAttribute('aria-label', 'Not running');
    await expect(page.locator('[data-testid="terminal"]')).toHaveCount(0);
  });

  test('opening a row runs folder_session_open from the launch folder and files a normal DM in the section', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openFolder(page);
    const target = page.locator('[data-fs-session]', {
      has: page.getByLabel('Worktree: .claude/worktrees/fix-login'),
    });
    const sid = (await target.first().getAttribute('data-fs-session'))!;
    const name = (await target.first().locator('[data-testid="fs-name"]').textContent())!;
    await target.first().click();
    // The DM exists in the section and is the open conversation, with the resumed history.
    const dm = page.locator('.side [data-group="atlas"] .row[data-dm]');
    await expect(dm).toHaveCount(1);
    await expect(dm.locator('.nm')).toHaveText(name);
    await expect(dm).toHaveAttribute('aria-current', 'true');
    await expect(dm.getByLabel('Worktree: .claude/worktrees/fix-login')).toBeVisible();
    await expect(page.locator('[data-fs-session="' + sid + '"]')).toHaveCount(0);
    await expect(page.getByTestId('chat')).toContainText('Picking up where we left off');
    const opens = await page.evaluate(() => window.__PR_MOCK__!.folderOpens);
    expect(opens).toEqual([
      { sectionId: 'atlas', sessionId: sid, cwd: `${HOME}/.claude/worktrees/fix-login` },
    ]);
    const stored = await page.evaluate(() => window.__PR_MOCK__!.sessions());
    expect(stored).toHaveLength(1);
    expect(stored[0].sectionId).toBe('atlas');
    expect(stored[0].cwd).toBe(`${HOME}/.claude/worktrees/fix-login`);
    // It is a normal DM now: the context menu is the DM menu.
    await dm.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Star' })).toBeVisible();
    expect(errs).toEqual([]);
  });

  test('the hover card shows the last prompt, the name source and the launch folder', async ({
    page,
  }) => {
    await openFolder(page);
    const row = rows(page).first();
    await row.hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Last prompt');
    await expect(tip).toContainText('Follow-up');
    await expect(tip).toContainText(HOME);
    await page.mouse.move(900, 500);
    await expect(tip).toHaveCount(0);
    // Keyboard focus shows it too.
    await row.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tooltip')).toBeVisible();
  });

  test('every name source reads in the hover card', async ({ page }) => {
    await openFolder(page);
    const seen = new Map<string, string>();
    for (const src of ['user', 'registry', 'custom-title', 'ai-title', 'prompt']) {
      const sid = await page.evaluate(
        (s) =>
          window
            .__PR_MOCK__!.folderRows('atlas')
            .find(
              (r) =>
                r.nameSource === s && !r.hidden && r.launchCwd.startsWith('/Users/me/code/atlas'),
            )!.sessionId,
        src,
      );
      const row = page.locator(`[data-fs-session="${sid}"]`);
      await row.scrollIntoViewIfNeeded().catch(() => undefined);
      if (!(await row.isVisible())) await page.locator('.fs-older').click();
      await row.hover();
      seen.set(src, (await page.getByRole('tooltip').locator('.fs-tip__src').textContent())!);
      await page.mouse.move(900, 500);
    }
    expect([...seen.values()]).toEqual([
      'Named in Patchroom',
      'From the session-naming registry',
      'From /rename',
      'Title written by Claude',
      'First prompt',
    ]);
  });

  test('New DM from a folder section starts in its folder, files there, and can switch worktree', async ({
    page,
  }) => {
    await openFolder(page);
    await page.locator('.side [data-group="atlas"] .sec-h').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New DM here' }).click();
    const dlg = page.getByRole('dialog', { name: 'New DM' });
    await expect(dlg.getByLabel('Folder')).toHaveValue(HOME);
    // The worktree switch lists the home folder and the discovered worktrees.
    const sel = dlg.getByLabel('Worktree');
    await expect(sel.locator('option')).toContainText([
      'atlas (home folder)',
      '.claude/worktrees/fix-login',
      '.claude/worktrees/perf-sweep',
      'packages/api',
      'atlas-release (linked worktree)',
    ]);
    await sel.selectOption(`${HOME}/.claude/worktrees/perf-sweep`);
    await expect(dlg.getByLabel('Folder')).toHaveValue(`${HOME}/.claude/worktrees/perf-sweep`);
    await dlg.getByRole('button', { name: 'Start DM' }).click();
    const dm = page.locator('.side [data-group="atlas"] .row[data-dm]');
    await expect(dm).toHaveCount(1);
    const s = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0]);
    expect(s.cwd).toBe(`${HOME}/.claude/worktrees/perf-sweep`);
    expect(s.sectionId).toBe('atlas');
    // Inside the folder, so no away chip.
    await expect(dm.getByTestId('folder-chip')).toHaveCount(0);
  });

  test('the header New DM button is unchanged: no section, last folder', async ({ page }) => {
    await openFolder(page);
    await chooseNew(page, 'New DM');
    const dlg = page.getByRole('dialog', { name: 'New DM' });
    await expect(dlg.getByLabel('Worktree')).toHaveCount(0);
    await dlg.getByLabel('Folder').fill('/tmp/elsewhere');
    await dlg.getByRole('button', { name: 'Start DM' }).click();
    await expect(page.locator('.side [data-group="__default__"] .row[data-dm]')).toHaveCount(1);
  });

  test('loading, empty and error states', async ({ page }) => {
    await openSeeded(page, []);
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.failNextFolderRead = true;
      m.addSection({ id: 'atlas', name: 'atlas', folder: '/Users/me/code/atlas' });
      return window.__PR_STORE__!.refresh();
    });
    const body = page.locator('[data-folder-body="atlas"]');
    await expect(body.getByRole('alert')).toContainText('Could not read the sessions');
    await body.getByRole('button', { name: 'Try again' }).click();
    await expect(rows(page).first()).toBeVisible();
    // A folder with no sessions says so; one with only hidden ones offers the toggle.
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.addSection({ id: 'empty', name: 'empty', folder: '/tmp/empty-folder' });
      m.setFolderRows('empty', []);
      m.addSection({ id: 'quiet', name: 'quiet', folder: '/tmp/quiet-folder' });
      for (const r of m.folderRows('quiet'))
        m.patchFolderSession('quiet', r.sessionId, { hidden: true });
      return window.__PR_STORE__!.refresh();
    });
    await expect(page.locator('[data-folder-body="empty"]').getByTestId('fs-empty')).toContainText(
      'No resumable sessions',
    );
    await expect(page.locator('[data-folder-body="quiet"]')).toContainText('Show 4 hidden');
    await expect(page.locator('[data-folder-body="quiet"]').getByTestId('fs-empty')).toHaveCount(0);
  });

  test('68 sessions render and the sidebar scrolls instead of overflowing', async ({ page }) => {
    await openFolder(page);
    expect((await folderNames(page)).length).toBeGreaterThanOrEqual(40);
    const over = await page.evaluate(() => {
      const s = document.querySelector('.side-scroll')!;
      return { sw: s.scrollWidth, cw: s.clientWidth, sh: s.scrollHeight, ch: s.clientHeight };
    });
    expect(over.sw).toBeLessThanOrEqual(over.cw);
    expect(over.sh).toBeGreaterThan(over.ch);
  });
});
