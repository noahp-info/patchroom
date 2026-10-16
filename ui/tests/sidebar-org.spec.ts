import { expect, test, type Page } from '@playwright/test';
import {
  backendDms,
  chooseNew,
  dragTo,
  headerOf,
  openSeeded,
  openSidebarDemo,
  renderedGroups,
  setTheme,
  storedSections,
  textContrast,
  watchErrors,
} from './helpers';

const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];
const plus = (page: Page) => page.getByRole('button', { name: 'Create new' });
const menuItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });
const pickEmoji = async (page: Page, emoji: string) => {
  await page.locator(`.picker .emoji[data-emoji="${emoji}"]`).first().click();
};

test.describe('sidebar organization: hierarchy (bar 1)', () => {
  test('headers are side-strong at 700, rows side-fg at 400, a hairline sits above every section but the first', async ({
    page,
  }) => {
    await openSidebarDemo(page);
    const look = await page.evaluate(() => {
      const probe = (token: string) => {
        const el = document.createElement('i');
        el.style.color = `var(${token})`;
        document.querySelector('.pr-app')!.appendChild(el);
        const c = getComputedStyle(el).color;
        el.remove();
        return c;
      };
      const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      const header = cs('.side [data-group="gn"] > .sec-h');
      const row = cs('.side [data-dm="dm-a"] .nm');
      const secs = [...document.querySelectorAll<HTMLElement>('.side .side-scroll > .sec')];
      return {
        strong: probe('--side-strong'),
        fg: probe('--side-fg'),
        line: probe('--side-line'),
        headerColor: header.color,
        headerWeight: header.fontWeight,
        rowColor: row.color,
        rowWeight: row.fontWeight,
        tops: secs.map((s) => ({
          id: s.dataset.group,
          kind: s.dataset.kind,
          w: getComputedStyle(s).borderTopWidth,
          c: getComputedStyle(s).borderTopColor,
          prev: s.previousElementSibling
            ? (s.previousElementSibling as HTMLElement).dataset.kind
            : null,
        })),
      };
    });
    expect(look.headerColor).toBe(look.strong);
    expect(look.headerWeight).toBe('700');
    expect(look.rowColor).toBe(look.fg);
    expect(look.rowWeight).toBe('400');
    expect(look.tops[0].w).toBe('0px');
    for (const t of look.tops.slice(1)) {
      if (t.kind === 'divider' || t.prev === 'divider') continue; // a divider is its own rule
      expect(t.w, `hairline above ${t.id}`).toBe('1px');
      expect(t.c).toBe(look.line);
    }
  });

  for (const theme of THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      test(`${theme} ${mode}: header 7:1 or better on the band, 1.5 stronger than a row`, async ({
        page,
      }) => {
        await openSidebarDemo(page, { id: theme, mode });
        const header = await textContrast(page, '.side [data-group="gn"] > .sec-h');
        const row = await textContrast(page, '.side [data-dm="dm-a"] .nm');
        expect(header, `${theme} ${mode} header ${header.toFixed(2)}`).toBeGreaterThanOrEqual(7);
        expect(header - row, `${theme} ${mode} header ${header} row ${row}`).toBeGreaterThanOrEqual(
          1.5,
        );
        expect(row).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

test.describe('sidebar organization: one-line rows (bar 2)', () => {
  test('30 sessions mostly on dev: chips only where the branch differs, no path line, one line each', async ({
    page,
  }) => {
    await openSidebarDemo(page);
    const rows = page.locator('.side [data-folder-body="gn"] > .fs-item .fs-row');
    const n = await rows.count();
    expect(n).toBeGreaterThan(14);
    const info = await page.evaluate(() => {
      const listing = window.__PR_MOCK__!.folderRows('gn');
      return listing.map((r) => ({
        id: r.sessionId,
        branch: r.branch,
        folderBranch: r.folderBranch,
        wt: r.relPath.includes('worktrees/'),
      }));
    });
    expect(info.every((r) => r.folderBranch === 'dev')).toBe(true);
    // The chips on screen are exactly the sessions off dev that are not an auto-named worktree.
    const chips = await page
      .locator('.side [data-folder-body="gn"] [data-chip="branch"]')
      .allTextContents();
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThan(n / 2);
    expect(chips.every((c) => /^lane-\d+$/.test(c.trim()))).toBe(true);
    const titles = await page
      .locator('.side [data-folder-body="gn"] [data-chip="branch"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    expect(titles.every((t) => /^feat\/lane-\d+$/.test(t ?? ''))).toBe(true);
    await expect(page.locator('.side [data-chip="branch"]', { hasText: /^dev$/ })).toHaveCount(0);
    await expect(page.locator('.side [data-chip="path"], .side .fs-l2')).toHaveCount(0);
    await expect(page.locator('.side [data-folder-body="gn"] .fs-wt').first()).toBeVisible();
    // Every row, lazy or open DM, is one line.
    const heights = await page
      .locator('.side .row')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(Math.max(...heights)).toBeLessThanOrEqual(32);
  });

  test('the chip follows the folder branch: move the folder to a feature branch and dev rows gain one', async ({
    page,
  }) => {
    await openSidebarDemo(page);
    const before = await page.locator('.side [data-folder-body="gn"] [data-chip="branch"]').count();
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.setFolderRows(
        'gn',
        m.folderRows('gn').map((r) => ({ ...r, folderBranch: 'feat/lane-3' })),
      );
    });
    await expect
      .poll(() => page.locator('.side [data-folder-body="gn"] [data-chip="branch"]').count())
      .toBeGreaterThan(before);
    await expect(
      page
        .locator('.side [data-folder-body="gn"] [data-chip="branch"]', { hasText: 'dev' })
        .first(),
    ).toBeVisible();
  });

  test('the hover card holds the branch, the path and the last prompt', async ({ page }) => {
    await openSidebarDemo(page);
    const row = page.locator('[data-fs-session="gn-010"]');
    await row.hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toBeVisible();
    await expect(tip.getByTestId('tip-branch')).toHaveText('dev');
    await expect(tip).toContainText('/Users/me/code/gamerNetworking');
    await expect(tip).toContainText('Last prompt');
    await expect(tip).toContainText('Keep it small and run the checks first.');
  });

  test('an open DM row is one line too and shows the same card', async ({ page }) => {
    await openSidebarDemo(page);
    const dm = page.locator('.side .row[data-dm="dm-art"]');
    expect(
      await dm.evaluate((e) => Math.round(e.getBoundingClientRect().height)),
    ).toBeLessThanOrEqual(32);
    await dm.hover();
    await expect(page.getByRole('tooltip')).toContainText('Last prompt');
    await expect(page.getByTestId('tip-branch')).toHaveText('dev');
  });
});

test.describe('sidebar organization: emoji (bar 3)', () => {
  test('create with the reaction picker: it leads the header, feeds recents and survives a restart', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openSeeded(page, [], { query: 'mock&persist' });
    await chooseNew(page, 'New section');
    await page.getByTestId('sec-emoji-btn').click();
    const picker = page.getByRole('dialog', { name: 'Section emoji' });
    await expect(picker).toBeVisible();
    // The same picker the reactions use: search, then pick.
    await picker.getByLabel('Find an emoji').fill('rocket');
    await pickEmoji(page, '\u{1F680}');
    await page.getByLabel('Section name').fill('Launch');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const header = page
      .locator('.side [data-kind="section"]', { hasText: 'Launch' })
      .locator('.sec-h');
    await expect(header.getByTestId('sec-emoji')).toHaveText('\u{1F680}');
    expect((await storedSections(page)).find((s) => s[2] === 'Launch')).toEqual([
      expect.any(String),
      'section',
      'Launch',
      '\u{1F680}',
    ]);
    // Recents are the reactions' recents: the next picker lists it first.
    await chooseNew(page, 'New section');
    await page.getByTestId('sec-emoji-btn').click();
    await expect(page.getByTestId('emoji-recent').locator('.emoji').first()).toHaveText(
      '\u{1F680}',
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(
      page
        .locator('.side [data-kind="section"]', { hasText: 'Launch' })
        .locator('.sec-h [data-testid="sec-emoji"]'),
    ).toHaveText('\u{1F680}');
    expect(errs).toEqual([]);
  });

  test('typed emoji work in the name, and rename changes or clears the picked one', async ({
    page,
  }) => {
    await openSeeded(page, [], { sections: [{ id: 's1', name: 'Work' }] });
    await expect(headerOf(page, 's1').getByTestId('sec-emoji')).toHaveCount(0);
    // Typed in the name.
    await headerOf(page, 's1').click({ button: 'right' });
    await menuItem(page, 'Rename section').click();
    const input = page.locator('.side [data-group="s1"] input[name="name"]');
    await input.fill('\u{1F4BC} Work');
    await input.press('Enter');
    await expect(headerOf(page, 's1')).toContainText('\u{1F4BC} Work');
    // Picked in rename: the row stays open, then Enter saves the name.
    await headerOf(page, 's1').dblclick();
    await page.getByTestId('sec-emoji-btn').click();
    await pickEmoji(page, '\u{1F525}');
    await expect(page.locator('.side [data-group="s1"] input[name="name"]')).toBeFocused();
    await page.locator('.side [data-group="s1"] input[name="name"]').press('Enter');
    await expect(headerOf(page, 's1').getByTestId('sec-emoji')).toHaveText('\u{1F525}');
    expect((await storedSections(page))[0][3]).toBe('\u{1F525}');
    // Clear it.
    await headerOf(page, 's1').dblclick();
    await page.getByTestId('sec-emoji-btn').click();
    await page.getByTestId('emoji-clear').click();
    await page.locator('.side [data-group="s1"] input[name="name"]').press('Enter');
    await expect(headerOf(page, 's1').getByTestId('sec-emoji')).toHaveCount(0);
    expect((await storedSections(page))[0][3]).toBeNull();
  });
});

test.describe('sidebar organization: dividers (bar 4)', () => {
  test('New divider from the + menu: labeled and unlabeled, in the stored order', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openSeeded(page, [], { sections: [{ id: 's1', name: 'Work' }] });
    await plus(page).click();
    await menuItem(page, 'New divider').click();
    await page.getByLabel('Divider label').fill('Later');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await plus(page).click();
    await menuItem(page, 'New divider').click();
    await page.getByRole('button', { name: 'Add', exact: true }).click(); // no label is allowed
    await expect
      .poll(async () => (await storedSections(page)).map((s) => [s[1], s[2]]))
      .toEqual([
        ['section', 'Work'],
        ['divider', 'Later'],
        ['divider', ''],
      ]);
    await expect(page.locator('.side [data-kind="divider"]')).toHaveCount(2);
    await expect(page.locator('.side [data-kind="divider"]').first()).toContainText('Later');
    expect(errs).toEqual([]);
  });

  test('New divider from a section menu lands above that section', async ({ page }) => {
    await openSeeded(page, [], {
      sections: [
        { id: 's1', name: 'One' },
        { id: 's2', name: 'Two' },
      ],
    });
    await headerOf(page, 's2').click({ button: 'right' });
    await menuItem(page, 'New divider').click();
    await expect
      .poll(async () => (await storedSections(page)).map((s) => s[1]))
      .toEqual(['section', 'divider', 'section']);
    expect((await renderedGroups(page)).slice(0, 4)).toEqual([
      '__starred__',
      's1',
      expect.any(String),
      's2',
    ]);
  });

  test('a labeled divider folds every section below it, up to the next divider; an unlabeled one only rules', async ({
    page,
  }) => {
    await openSidebarDemo(page);
    const rowsIn = (id: string) => page.locator(`.side [data-group="${id}"] .row`);
    await expect(rowsIn('kf').first()).toBeVisible();
    await headerOf(page, 'div-side').click();
    // kf and lab sit under "Side projects" (up to the unlabeled divider): both fold away.
    await expect(page.locator('.side [data-group="kf"]')).toHaveCount(0);
    await expect(page.locator('.side [data-group="lab"]')).toHaveCount(0);
    await expect(headerOf(page, 'div-side')).toHaveAttribute('aria-expanded', 'false');
    // Sections above it and below the next divider stay.
    await expect(headerOf(page, 'gn')).toBeVisible();
    await expect(headerOf(page, '__default__')).toBeVisible();
    await expect(rowsIn('__default__').first()).toBeVisible();
    // The unlabeled divider is a rule, not a fold.
    await expect(headerOf(page, 'div-plain')).not.toHaveAttribute('aria-expanded', /.*/);
    expect(
      await page.evaluate(
        () => window.__PR_MOCK__!.sections().find((s) => s.id === 'div-side')!.collapsed,
      ),
    ).toBe(true);
    await headerOf(page, 'div-side').click();
    await expect(headerOf(page, 'kf')).toBeVisible();
    await expect(headerOf(page, 'lab')).toBeVisible();
  });

  test('rename, delete and drag work; deleting a divider keeps its sections; the order survives a restart', async ({
    page,
  }) => {
    await openSeeded(page, [], {
      query: 'mock&persist',
      sections: [
        { id: 's1', name: 'One' },
        { id: 's2', name: 'Two' },
      ],
    });
    await page.evaluate(async () => {
      window.__PR_MOCK__!.addSection({ id: 'dv', name: 'Group', kind: 'divider', position: 2 });
      await window.__PR_STORE__!.refresh();
    });
    // Rename through the divider's menu.
    await headerOf(page, 'dv').click({ button: 'right' });
    await menuItem(page, 'Rename divider').click();
    const input = page.locator('.side [data-group="dv"] input[name="name"]');
    await input.fill('Parked');
    await input.press('Enter');
    await expect(headerOf(page, 'dv')).toContainText('Parked');
    // Drag it above section One, like a section.
    await dragTo(page, headerOf(page, 'dv'), headerOf(page, 's1'), 'top');
    await expect
      .poll(async () => (await storedSections(page)).map((s) => s[0]))
      .toEqual(['dv', 's1', 's2']);
    await page.reload();
    expect((await renderedGroups(page)).slice(1, 4)).toEqual(['dv', 's1', 's2']);
    await expect(headerOf(page, 'dv')).toContainText('Parked');
    // Delete: only the divider goes.
    await headerOf(page, 'dv').click({ button: 'right' });
    await menuItem(page, 'Delete divider').click();
    await expect(page.locator('.side [data-kind="divider"]')).toHaveCount(0);
    await expect(headerOf(page, 's1')).toBeVisible();
    await expect(headerOf(page, 's2')).toBeVisible();
    expect((await storedSections(page)).map((s) => s[0])).toEqual(['s1', 's2']);
  });

  test('a DM cannot be dropped on a divider; a section drops past one', async ({ page }) => {
    await openSeeded(page, [{ id: 'a', name: 'alpha', sectionId: 's1' }], {
      sections: [
        { id: 's1', name: 'One' },
        { id: 's2', name: 'Two' },
      ],
    });
    await page.evaluate(async () => {
      window.__PR_MOCK__!.addSection({ id: 'dv', name: 'Group', kind: 'divider', position: 0.5 });
      await window.__PR_STORE__!.refresh();
    });
    await dragTo(page, page.locator('.side .row[data-dm="a"]'), headerOf(page, 'dv'));
    expect((await backendDms(page))[0].sectionId).toBe('s1');
    // Drag section One below the divider: One, Group, Two becomes Group, One, Two.
    expect((await storedSections(page)).map((x) => x[0])).toEqual(['s1', 'dv', 's2']);
    await dragTo(page, headerOf(page, 's1'), headerOf(page, 'dv'), 'bottom');
    await expect
      .poll(async () => (await storedSections(page)).map((s) => s[0]))
      .toEqual(['dv', 's1', 's2']);
  });
});

test.describe('sidebar organization: collapse never hides what needs you (bar 5)', () => {
  test('a collapsed section keeps its needs-you DM as a row, with red and unread counts on the header', async ({
    page,
  }) => {
    await openSidebarDemo(page);
    await headerOf(page, 'gn').click();
    await expect(headerOf(page, 'gn')).toHaveAttribute('aria-expanded', 'false');
    // The folder's 15 listed sessions fold away; the waiting DM and nothing else stays.
    await expect(page.locator('.side [data-group="gn"] .fs-row')).toHaveCount(0);
    const peek = page.locator('.side [data-group="gn"] [data-testid="needs-peek"] .row');
    await expect(peek).toHaveCount(1);
    await expect(peek).toHaveAttribute('data-dm', 'dm-ci');
    await expect(peek).toHaveAttribute('data-status', 'waiting');
    await expect(headerOf(page, 'gn').locator('.bdg.needs')).toHaveText('1');
    // The unread DM (art-pass, 3) is folded: it counts on the header instead.
    await expect(page.locator('.side [data-group="gn"] .row[data-dm="dm-art"]')).toHaveCount(0);
    await expect(headerOf(page, 'gn').locator('.bdg.unr')).toHaveText('3');
    // The needs badge is red: the theme's needs background.
    const red = await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.background = 'var(--needs)';
      document.querySelector('.pr-app')!.appendChild(probe);
      const need = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        need,
        bg: getComputedStyle(document.querySelector('.side [data-group="gn"] > .sec-h .bdg.needs')!)
          .backgroundColor,
      };
    });
    expect(red.bg).toBe(red.need);
    // The row still opens its DM.
    await peek.click();
    await expect(peek).toHaveAttribute('aria-current', 'true');
  });

  test('a folded divider group shows every needs-you DM under it and sums the counts', async ({
    page,
  }) => {
    await openSidebarDemo(page);
    await headerOf(page, 'div-side').click();
    const peek = page.locator('.side [data-group="div-side"] [data-testid="needs-peek"] .row');
    await expect(peek).toHaveCount(1);
    await expect(peek).toHaveAttribute('data-dm', 'dm-kf2');
    await expect(headerOf(page, 'div-side').locator('.bdg.needs')).toHaveText('1');
    // Quiet DMs of the folded sections are not listed.
    await expect(page.locator('.side .row[data-dm="dm-kf1"]')).toHaveCount(0);
    await expect(page.locator('.side .row[data-dm="dm-lab"]')).toHaveCount(0);
    // Cmd+K still finds a DM that is folded away.
    await page.keyboard.press('Meta+k');
    await page.getByRole('combobox', { name: 'Jump to a session' }).fill('receipts');
    await expect(
      page.locator('#qs-list .palette__name', { hasText: 'receipts-tracker' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    // Answering the prompt clears the row and the count.
    await page.evaluate(() => window.__PR_MOCK__!.setStatus('dm-kf2', 'idle'));
    await expect(peek).toHaveCount(0);
    await expect(headerOf(page, 'div-side').locator('.bdg.needs')).toHaveCount(0);
  });
});

test.describe('sidebar organization: collapse all and keyboard (bars 6, 7)', () => {
  test('Option+click on any header collapses everything, then expands everything', async ({
    page,
  }) => {
    await openSidebarDemo(page);
    const state = () =>
      page
        .locator('.side .side-scroll > .sec[data-collapsed]')
        .evaluateAll((els) =>
          els.map((e) => [(e as HTMLElement).dataset.group, (e as HTMLElement).dataset.collapsed]),
        );
    await headerOf(page, 'gn').click({ modifiers: ['Alt'] });
    // Sections and the labeled divider fold. The folded divider hides what is under it, so the
    // groups left are the ones outside it.
    await expect.poll(async () => (await state()).every(([, c]) => c === 'true')).toBe(true);
    await expect(page.locator('.side .fs-row')).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        window
          .__PR_MOCK__!.sections()
          .filter((s) => s.kind !== 'divider' || s.name)
          .map((s) => s.collapsed),
      ),
    ).toEqual([true, true, true, true]);
    // Needs-you rows stay through a collapse-all.
    await expect(
      page.locator('.side [data-testid="needs-peek"] .row[data-status="waiting"]'),
    ).toHaveCount(2);
    await headerOf(page, 'div-side').click({ modifiers: ['Alt'] });
    await expect.poll(async () => (await state()).every(([, c]) => c === 'false')).toBe(true);
    await expect(page.locator('.side .fs-row').first()).toBeVisible();
    await expect(page.locator('.side [data-testid="needs-peek"]')).toHaveCount(0);
  });

  test('headers and dividers are tab stops; Enter and Space toggle; an unlabeled divider is reachable too', async ({
    page,
  }) => {
    await openSidebarDemo(page);
    await headerOf(page, 'div-side').focus();
    await expect(headerOf(page, 'div-side')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(headerOf(page, 'div-side')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(headerOf(page, 'div-side')).toHaveAttribute('aria-expanded', 'true');
    // Tab walks header to header through the rows.
    await headerOf(page, 'kf').focus();
    await page.keyboard.press('Space');
    await expect(headerOf(page, 'kf')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    // Tab from the section header: the next stop is its DM row, then the next header.
    await page.keyboard.press('Tab');
    await expect(page.locator('.side .row[data-dm="dm-kf1"]')).toBeFocused();
    await headerOf(page, 'div-plain').focus();
    await expect(headerOf(page, 'div-plain')).toBeFocused();
    await expect(headerOf(page, 'div-plain')).toHaveAccessibleName('Divider, no label');
    // Enter on an unlabeled divider offers a label.
    await page.keyboard.press('Enter');
    const input = page.locator('.side [data-group="div-plain"] input[name="name"]');
    await expect(input).toBeFocused();
    await input.fill('Parked');
    await input.press('Enter');
    await expect(headerOf(page, 'div-plain')).toHaveAttribute('aria-expanded', 'true');
    expect((await storedSections(page)).find((s) => s[0] === 'div-plain')?.[2]).toBe('Parked');
    // Alt+Enter is the keyboard form of Option+click.
    await headerOf(page, 'gn').focus();
    await page.keyboard.press('Alt+Enter');
    await expect(page.locator('.side .fs-row')).toHaveCount(0);
  });

  test('the section context menu opens from the keyboard on a divider', async ({ page }) => {
    await openSidebarDemo(page);
    await headerOf(page, 'div-side').focus();
    await page.keyboard.press('Shift+F10');
    await expect(menuItem(page, 'Rename divider')).toBeVisible();
    await expect(menuItem(page, 'Delete divider')).toBeVisible();
    await expect(menuItem(page, 'New divider')).toBeVisible();
  });
});

test.describe('sidebar organization: P3 data and stored state (bar 9)', () => {
  test('a P3-era stored section with no kind or emoji loads as a plain section', async ({
    page,
  }) => {
    // The persisted backend as a P3 build left it: sections carry no `kind` and no `emoji`.
    await page.goto('/?mock&persist');
    await page.waitForFunction(() => !!window.__PR_MOCK__);
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.addSection({ id: 'old', name: 'Old section', position: 0, collapsed: true });
      m.addSection({ id: 'old2', name: 'Another', position: 1 });
      const raw = JSON.parse(window.localStorage.getItem('patchroom.mock.state')!) as {
        sections: Record<string, unknown>[];
      };
      for (const sec of raw.sections) {
        delete sec.kind;
        delete sec.emoji;
      }
      window.localStorage.setItem('patchroom.mock.state', JSON.stringify(raw));
    });
    await page.reload();
    await expect(headerOf(page, 'old')).toContainText('Old section');
    await expect(headerOf(page, 'old')).toHaveAttribute('aria-expanded', 'false');
    await expect(headerOf(page, 'old2')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.side [data-group="old"]')).toHaveAttribute('data-kind', 'section');
    await expect(page.locator('.side [data-testid="sec-emoji"]')).toHaveCount(0);
    await expect(page.locator('.side [data-kind="divider"]')).toHaveCount(0);
  });

  for (const mode of ['light', 'dark'] as const) {
    test(`${mode}: the organized sidebar renders with every theme's tokens`, async ({
      page,
    }, testInfo) => {
      await openSidebarDemo(page);
      for (const theme of THEMES) {
        await setTheme(page, theme, mode);
        await testInfo.attach(`sidebar-${theme}-${mode}.png`, {
          body: await page.locator('aside.side').screenshot(),
          contentType: 'image/png',
        });
      }
    });
  }
});
