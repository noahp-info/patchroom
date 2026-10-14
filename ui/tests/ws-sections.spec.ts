import { expect, test } from '@playwright/test';
import { backendDms, chooseNew, dragTo, groupRows, openSeeded, watchErrors } from './helpers';

const DMS = [
  { id: 'a', name: 'alpha' },
  { id: 'b', name: 'beta' },
  { id: 'c', name: 'gamma' },
  { id: 'd', name: 'delta' },
];

test.describe('workspace: sections (checklist 1, 2)', () => {
  test('Starred, Direct messages and Archived exist on first run', async ({ page }) => {
    await page.goto('/?mock');
    for (const name of ['Starred', 'Direct messages', 'Archived']) {
      await expect(page.locator('.side .sec-h', { hasText: name })).toBeVisible();
    }
    // Archived starts collapsed; Starred and Direct messages are open.
    await expect(page.locator('.side [data-group="__archived__"] .sec-h')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('create, rename, collapse and delete a section; its DMs fall back to Direct messages', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openSeeded(page, DMS.slice(0, 2), { sections: [{ id: 'sec-1', name: 'Work' }] });
    await page.evaluate(() => window.__PR_MOCK__!.sessions()); // keep the page alive
    // Create through the sidebar form.
    await chooseNew(page, 'New section');
    await page.getByLabel('Section name').fill('Reviews');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.side [data-kind="section"]')).toHaveCount(2);

    // Move beta into Work, then rename Work through its context menu.
    await page.locator('.side .row', { hasText: 'beta' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to Work' }).click();
    expect(await groupRows(page, 'sec-1')).toEqual(['beta']);
    await page.locator('.side [data-group="sec-1"] .sec-h').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename section' }).click();
    const input = page.locator('.side [data-group="sec-1"] input');
    await input.fill('Client work');
    await input.press('Enter');
    await expect(page.locator('.side [data-group="sec-1"] .sec-h')).toContainText('Client work');
    expect(await page.evaluate(() => window.__PR_MOCK__!.sections().map((s) => s.name))).toContain(
      'Client work',
    );

    // Collapse hides the rows and persists.
    await page.locator('.side [data-group="sec-1"] .sec-h').click();
    await expect(page.locator('.side [data-group="sec-1"] .row')).toHaveCount(0);
    expect(
      await page.evaluate(
        () => window.__PR_MOCK__!.sections().find((s) => s.id === 'sec-1')!.collapsed,
      ),
    ).toBe(true);
    await page.locator('.side [data-group="sec-1"] .sec-h').click();

    // Delete: the DM returns to Direct messages.
    await page.locator('.side [data-group="sec-1"] .sec-h').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete section' }).click();
    await expect(page.locator('.side [data-group="sec-1"]')).toHaveCount(0);
    expect(await groupRows(page, '__default__')).toContain('beta');
    expect((await backendDms(page)).find((d) => d.id === 'b')!.sectionId).toBeNull();
    expect(errs).toEqual([]);
  });

  test('sections reorder by dragging their headers', async ({ page }) => {
    await openSeeded(page, [], {
      sections: [
        { id: 's1', name: 'One' },
        { id: 's2', name: 'Two' },
        { id: 's3', name: 'Three' },
      ],
    });
    const order = () =>
      page
        .locator('.side [data-kind="section"]')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group));
    expect(await order()).toEqual(['s1', 's2', 's3']);
    await dragTo(
      page,
      page.locator('.side [data-group="s1"] .sec-h'),
      page.locator('.side [data-group="s3"] .sec-h'),
      'bottom',
    );
    await expect.poll(order).toEqual(['s2', 's3', 's1']);
    expect(await page.evaluate(() => window.__PR_MOCK__!.sections().map((s) => s.id))).toEqual([
      's2',
      's3',
      's1',
    ]);
  });

  test('a DM drags between sections and reorders inside one', async ({ page }) => {
    await openSeeded(
      page,
      [{ ...DMS[0], sectionId: 's1' }, { ...DMS[1], sectionId: 's1' }, DMS[2]],
      {
        sections: [
          { id: 's1', name: 'One' },
          { id: 's2', name: 'Two' },
        ],
      },
    );
    // Into an empty section's header.
    await dragTo(
      page,
      page.locator('.side .row', { hasText: 'gamma' }),
      page.locator('.side [data-group="s2"] .sec-h'),
    );
    await expect.poll(() => groupRows(page, 's2')).toEqual(['gamma']);
    // Reorder inside One: put beta before alpha.
    await dragTo(
      page,
      page.locator('.side [data-group="s1"] .row', { hasText: 'beta' }),
      page.locator('.side [data-group="s1"] .row', { hasText: 'alpha' }),
      'top',
    );
    await expect.poll(() => groupRows(page, 's1')).toEqual(['beta', 'alpha']);
    const calls = await page.evaluate(() => window.__PR_MOCK__!.reorderCalls);
    expect(calls.at(-1)).toEqual({ sectionId: 's1', ids: ['b', 'a'] });
    // A drag never opens the DM it started on.
    expect(await page.evaluate(() => window.__PR_STORE__!.getSnapshot().activeId)).toBeNull();
  });

  test('sections, order and flags survive an app restart', async ({ page }) => {
    await openSeeded(page, [{ ...DMS[0], sectionId: 's1' }, DMS[1], DMS[2]], {
      sections: [
        { id: 's1', name: 'One' },
        { id: 's2', name: 'Two' },
      ],
      query: 'mock&persist',
    });
    await page.locator('.side [data-group="s2"] .sec-h').click(); // collapse Two
    await dragTo(
      page,
      page.locator('.side [data-group="s2"] .sec-h'),
      page.locator('.side [data-group="s1"] .sec-h'),
      'top',
    );
    await page.locator('.side .row', { hasText: 'beta' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Star', exact: true }).click();
    await page.locator('.side .row', { hasText: 'gamma' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.side [data-group="__starred__"] .row')).toHaveText(/beta/);

    await page.reload(); // the backend (the mock, persisted) outlives the page
    await expect
      .poll(() =>
        page
          .locator('.side [data-kind="section"]')
          .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group)),
      )
      .toEqual(['s2', 's1']);
    await expect(page.locator('.side [data-group="s2"] .sec-h')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(await groupRows(page, 's1')).toEqual(['alpha']);
    await expect(page.locator('.side [data-group="__starred__"] .row')).toHaveText(/beta/);
    await page.locator('.side [data-group="__archived__"] .sec-h').click();
    await expect(page.locator('.side [data-group="__archived__"] .row')).toHaveText(/gamma/);
  });

  test('star and archive from the context menu; archived DMs leave the list and never badge', async ({
    page,
  }) => {
    await openSeeded(page, DMS.slice(0, 3));
    const menu = async (name: string, item: string) => {
      await page.locator(`.side .row`, { hasText: name }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: item, exact: true }).click();
    };
    await menu('alpha', 'Star');
    await expect(page.locator('.side [data-group="__starred__"] .row')).toHaveText(/alpha/);
    expect(await groupRows(page, '__default__')).not.toContain('alpha');
    await menu('alpha', 'Unstar');
    expect(await groupRows(page, '__default__')).toContain('alpha');

    // An unread count and a prompt on an archived DM show no badge.
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.setBadges('b', 4, false);
    });
    await expect(page.locator('.side .row', { hasText: 'beta' }).locator('.bdg.unr')).toHaveText(
      '4',
    );
    await menu('beta', 'Archive');
    expect(await groupRows(page, '__default__')).not.toContain('beta');
    await expect(page.locator('.side [data-group="__archived__"] .row')).toHaveCount(0); // collapsed
    await page.locator('.side [data-group="__archived__"] .sec-h').click();
    const row = page.locator('.side [data-group="__archived__"] .row', { hasText: 'beta' });
    await expect(row).toBeVisible();
    await expect(row.locator('.bdg')).toHaveCount(0);
    await menu('beta', 'Unarchive');
    expect(await groupRows(page, '__default__')).toContain('beta');
    const flags = await page.evaluate(() => window.__PR_MOCK__!.flagCalls);
    expect(flags.map((f) => Object.keys(f).join())).toContain('id,archived');
  });

  test('a DM drags into Starred and Archived', async ({ page }) => {
    await openSeeded(page, DMS.slice(0, 2));
    await dragTo(
      page,
      page.locator('.side .row', { hasText: 'alpha' }),
      page.locator('.side [data-group="__starred__"] .sec-h'),
    );
    await expect(page.locator('.side [data-group="__starred__"] .row')).toHaveText(/alpha/);
    await dragTo(
      page,
      page.locator('.side .row', { hasText: 'beta' }),
      page.locator('.side [data-group="__archived__"] .sec-h'),
    );
    expect((await backendDms(page)).find((d) => d.id === 'b')!.archived).toBe(true);
  });
});
