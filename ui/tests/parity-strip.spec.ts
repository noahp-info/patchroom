import { expect, test, type Page } from '@playwright/test';
import { dragTo, openChat, openSeeded, watchErrors } from './helpers';

// Session parity item 6: a status strip of modules, without doubles, that the user can customize.

// The DM folder is /tmp/patchroom-test. The user's statusLine prints the model, the folder and
// the cost, so those three chips (and the context share it prints) are doubles.
const LINE = '\x1b[36mOpus 4.8\x1b[0m | patchroom-test | $1.82 | ctx 64%';
const CHIPS = {
  model: 'Opus 4.8',
  contextPct: 64,
  cost: 1.82,
  mode: 'plan',
  worktree: 'wt/hook-bridge',
  branch: 'feat/hook-bridge',
  prUrl: 'https://github.com/acme/patchroom/pull/14',
};

const strip = (page: Page) => page.getByTestId('status-strip');
const chip = (page: Page, name: string) => strip(page).locator(`[data-chip="${name}"]`);
const chipOrder = (page: Page) =>
  strip(page).evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('[data-chip], [data-testid="statusline"]')].map(
      (n) => n.dataset.chip ?? 'statusline',
    ),
  );
const prefs = (page: Page) => page.evaluate(() => window.__PR_MOCK__!.prefs().statusBar);

async function feed(page: Page, id: string, text = LINE, chips: object = CHIPS) {
  await page.evaluate(([sid, t, c]) => window.__PR_MOCK__!.setStatusline(sid, t, c), [
    id,
    text,
    chips,
  ] as [string, string, object]);
}

async function openMenu(page: Page) {
  // Clear of the sidebar resize handle, which straddles the pane's left edge.
  await strip(page).click({ button: 'right', position: { x: 40, y: 4 } });
  const menu = page.getByRole('dialog', { name: 'Customize status bar' });
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('session parity: status strip without doubles', () => {
  test('chips that repeat the statusLine are hidden by default', async ({ page }) => {
    const errs = watchErrors(page);
    const id = await openChat(page, []);
    await feed(page, id);
    await expect(page.getByTestId('statusline')).toBeVisible();
    for (const dup of ['model', 'folder', 'cost', 'context'])
      await expect(chip(page, dup), `${dup} repeats the statusLine`).toHaveCount(0);
    // Facts the statusLine lacks still show.
    await expect(chip(page, 'mode')).toHaveText('plan');
    await expect(chip(page, 'worktree')).toHaveText('wt/hook-bridge');
    await expect(chip(page, 'branch')).toHaveText('feat/hook-bridge');
    await expect(chip(page, 'pr')).toHaveText('PR #14');
    // The statusLine text itself is verbatim, ANSI rendered.
    expect(await page.getByTestId('statusline').evaluate((el) => el.textContent)).toBe(
      'Opus 4.8 | patchroom-test | $1.82 | ctx 64%',
    );
    expect(errs).toEqual([]);
  });

  test('a partial overlap is not a double', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id, 'patchroom on main', { model: 'Opus 4.8', cost: 1.82 });
    // "patchroom" is not the folder "patchroom-test"; "main" is not a chip here.
    await expect(chip(page, 'folder')).toHaveText('patchroom-test');
    await expect(chip(page, 'model')).toHaveText('\u2601\uFE0F Opus 4.8');
    await expect(chip(page, 'cost')).toHaveText('$1.82');
  });

  test('with no statusLine every chip shows', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id, '', CHIPS);
    for (const c of ['model', 'folder', 'context', 'cost', 'mode', 'worktree', 'branch', 'pr'])
      await expect(chip(page, c)).toBeVisible();
    await expect(page.getByTestId('statusline')).toHaveCount(0);
  });

  test('the mode chip still cycles the mode', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id);
    await chip(page, 'mode').click();
    expect(await page.evaluate(() => window.__PR_MOCK__!.modeCycles)).toEqual([id]);
  });
});

test.describe('session parity: customize the status bar', () => {
  test('right-click opens the menu; the tray lists the hidden doubles', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id);
    const menu = await openMenu(page);
    const active = menu.getByRole('list', { name: 'Shown in the status bar' });
    await expect(active.locator('[data-mod]')).toHaveText([
      'Worktree',
      'Mode',
      'Branch',
      'Pull request',
      'Your statusLine',
    ]);
    const tray = menu.getByRole('list', { name: 'Tray' });
    await expect(tray.locator('[data-mod]')).toHaveText([/Model/, /Folder/, /Context/, /Cost/]);
    await expect(menu.getByTestId('dup-model')).toHaveText('Repeats your statusLine');
    // The gear on the strip opens the same menu.
    await page.keyboard.press('Escape');
    await page.getByTestId('strip-customize').click();
    await expect(page.getByRole('dialog', { name: 'Customize status bar' })).toBeVisible();
  });

  test('add from the tray, remove, and the choice persists in prefs', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id);
    const menu = await openMenu(page);
    await menu.getByRole('button', { name: 'Add Model' }).click();
    await expect(chip(page, 'model')).toHaveText('\u2601\uFE0F Opus 4.8');
    await menu.getByRole('button', { name: 'Remove Mode', exact: true }).click();
    await expect(chip(page, 'mode')).toHaveCount(0);
    const saved = (await prefs(page))!.default!;
    expect(saved).toContain('model');
    expect(saved).not.toContain('mode');
    // A saved layout is taken as written: the added chip shows although the statusLine says it too.
    await expect(page.getByTestId('statusline')).toContainText('Opus 4.8');
    // Mode sits in the tray now, no longer tagged as a double.
    await expect(menu.getByRole('button', { name: 'Add Mode', exact: true })).toBeVisible();
    await expect(menu.getByTestId('dup-mode')).toHaveCount(0);
  });

  test('drag reorders the strip', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id, '', CHIPS);
    const menu = await openMenu(page);
    const before = await chipOrder(page);
    expect(before.slice(0, 3)).toEqual(['model', 'folder', 'worktree']);
    const grip = menu.getByRole('button', { name: /^Reorder Cost/ });
    const first = menu.locator('[data-sbe-active] [data-mod="model"]');
    await dragTo(page, grip, first, 'top');
    await expect
      .poll(() => chipOrder(page))
      .toEqual(['cost', 'model', ...before.filter((c) => c !== 'cost' && c !== 'model')]);
    expect((await prefs(page))!.default!.slice(0, 2)).toEqual(['cost', 'model']);
  });

  test('keyboard reorder works from the grip', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id, '', CHIPS);
    const menu = await openMenu(page);
    const grip = menu.getByRole('button', { name: /^Reorder Folder/ });
    await grip.focus();
    await page.keyboard.press('ArrowUp');
    await expect
      .poll(() => chipOrder(page).then((o) => o.slice(0, 2)))
      .toEqual(['folder', 'model']);
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(() => chipOrder(page).then((o) => o.slice(0, 2)))
      .toEqual(['model', 'folder']);
  });

  test('dragging a row onto the tray removes it', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id, '', CHIPS);
    const menu = await openMenu(page);
    const grip = menu.getByRole('button', { name: /^Reorder Cost/ });
    await dragTo(page, grip, menu.getByRole('list', { name: 'Tray' }));
    await expect(chip(page, 'cost')).toHaveCount(0);
    await expect(menu.getByRole('button', { name: 'Add Cost' })).toBeVisible();
  });

  test('the statusLine is a module too: move it first, then remove it', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id);
    const menu = await openMenu(page);
    const grip = menu.getByRole('button', { name: /^Reorder Your statusLine/ });
    await dragTo(page, grip, menu.locator('[data-sbe-active] [data-mod]').first(), 'top');
    await expect.poll(() => chipOrder(page).then((o) => o[0])).toBe('statusline');
    await menu.getByRole('button', { name: 'Remove Your statusLine' }).click();
    await expect(page.getByTestId('statusline')).toHaveCount(0);
    await menu.getByRole('button', { name: 'Add Your statusLine' }).click();
    await expect(page.getByTestId('statusline')).toBeVisible();
  });

  test('the layout survives a restart', async ({ page }) => {
    const id = await openChat(page, [], 'mock&grid=100x30&persist');
    await feed(page, id);
    const menu = await openMenu(page);
    await menu.getByRole('button', { name: 'Remove Branch' }).click();
    await expect.poll(async () => (await prefs(page))!.default).not.toBeNull();
    await page.reload();
    await page.waitForFunction(() => !!window.__PR_STORE__?.getSnapshot().prefs);
    expect(await prefs(page)).toMatchObject({ default: expect.not.arrayContaining(['branch']) });
    // Reset: the built-in layout (null) returns and doubles hide again.
    await page.locator('.row[data-dm]').first().click();
    await page.evaluate(() => window.__PR_STORE__!.setStatusBar(null, null));
    expect((await prefs(page))!.default).toBeNull();
  });

  test('Reset restores the built-in layout', async ({ page }) => {
    const id = await openChat(page, []);
    await feed(page, id);
    const menu = await openMenu(page);
    await expect(menu.getByTestId('sb-reset')).toBeDisabled();
    await menu.getByRole('button', { name: 'Add Model' }).click();
    await expect(chip(page, 'model')).toBeVisible();
    await menu.getByTestId('sb-reset').click();
    await expect(chip(page, 'model')).toHaveCount(0);
    expect((await prefs(page))!.default).toBeNull();
  });

  test('a per-DM override changes one DM and leaves the others on the default', async ({
    page,
  }) => {
    await openSeeded(page, [
      { id: 'a', name: 'alpha', cwd: '/work/alpha' },
      { id: 'b', name: 'beta', cwd: '/work/beta' },
    ]);
    const chips = { model: 'Opus 4.8', mode: 'plan' };
    await page.evaluate(async (c) => {
      window.__PR_STORE__!.openDm('a');
      window.__PR_MOCK__!.setStatusline('a', '', c);
      window.__PR_MOCK__!.setStatusline('b', '', c);
    }, chips);
    await expect(chip(page, 'mode')).toBeVisible();
    const menu = await openMenu(page);
    await menu.getByTestId('sb-only-dm').check();
    await menu.getByRole('button', { name: 'Remove Mode', exact: true }).click();
    await expect(chip(page, 'mode')).toHaveCount(0);
    const saved = (await prefs(page))!;
    expect(saved.default).toBeNull();
    expect(saved.perDm.a).not.toContain('mode');
    expect(saved.perDm.b).toBeUndefined();
    // The other DM keeps the built-in layout.
    await page.evaluate(() => window.__PR_STORE__!.openDm('b'));
    await expect(chip(page, 'mode')).toBeVisible();
    // Unticking drops the override.
    await page.evaluate(() => window.__PR_STORE__!.openDm('a'));
    const menu2 = await openMenu(page);
    await menu2.getByTestId('sb-only-dm').uncheck();
    expect((await prefs(page))!.perDm.a).toBeUndefined();
  });

  test('Preferences has a Status bar tab with the same editor, global and per DM', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    const id = await openChat(page, []);
    await feed(page, id, '', CHIPS);
    await page.keyboard.press('Meta+,');
    const prefsDlg = page.getByRole('dialog', { name: 'Settings' });
    await prefsDlg.getByRole('button', { name: 'Status bar' }).click();
    const sec = page.getByTestId('prefs-statusbar');
    await expect(sec).toBeVisible();
    await sec.getByRole('button', { name: 'Remove Cost' }).click();
    await expect.poll(async () => (await prefs(page))!.default).not.toContain('cost');
    await sec.getByRole('button', { name: 'Add Cost' }).click();
    await expect.poll(async () => (await prefs(page))!.default).toContain('cost');
    // Per DM: pick the DM, change it, the global default stays.
    const globalBefore = (await prefs(page))!.default;
    await sec.getByLabel('Status bar applies to').selectOption(id);
    await sec.getByRole('button', { name: 'Remove Pull request' }).click();
    await expect.poll(async () => (await prefs(page))!.perDm[id]).toBeDefined();
    expect((await prefs(page))!.perDm[id]).not.toContain('pr');
    expect((await prefs(page))!.default).toEqual(globalBefore);
    await sec.getByTestId('statusbar-reset').click();
    await expect.poll(async () => (await prefs(page))!.perDm[id]).toBeUndefined();
    await page.keyboard.press('Escape');
    expect(errs).toEqual([]);
  });
});
