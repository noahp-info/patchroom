import { expect, test, type Page } from '@playwright/test';
import { openSeeded, watchErrors } from './helpers';

const DMS = [
  { id: 'a', name: 'alpha-api', cwd: '/work/api/alpha-api' },
  { id: 'b', name: 'beta-web', cwd: '/work/web/beta-web' },
  { id: 'c', name: 'gamma-docs', cwd: '/work/docs/gamma-docs' },
  { id: 'd', name: 'delta-infra', cwd: '/work/infra/delta-infra' },
];

/** Session rows; the closing "Search messages for" row is its own locator. */
const options = (page: Page) =>
  page
    .getByRole('dialog', { name: 'Quick switcher' })
    .locator('[role="option"]:not([data-search-row])');
const searchRow = (page: Page) =>
  page.getByRole('dialog', { name: 'Quick switcher' }).locator('[data-search-row]');
const active = (page: Page) => page.evaluate(() => window.__PR_STORE__!.getSnapshot().activeId);

test.describe('workspace: Cmd+K switcher (checklist 3)', () => {
  test('opens on Cmd+K, filters fuzzily, Enter opens the DM, Esc closes', async ({ page }) => {
    const errs = watchErrors(page);
    await openSeeded(page, DMS);
    await page.keyboard.press('Meta+k');
    const dlg = page.getByRole('dialog', { name: 'Quick switcher' });
    await expect(dlg).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Jump to a session' })).toBeFocused();
    await expect(options(page)).toHaveCount(4);
    // Subsequence match on the name: "gdc" finds gamma-docs.
    await page.keyboard.type('gdc');
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText('gamma-docs');
    await page.keyboard.press('Enter');
    await expect(dlg).toHaveCount(0);
    expect(await active(page)).toBe('c');
    // Esc closes without opening anything.
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('beta');
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    expect(await active(page)).toBe('c');
    expect(errs).toEqual([]);
  });

  test('matches folders, not just names', async ({ page }) => {
    await openSeeded(page, DMS);
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('infra');
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText('delta-infra');
  });

  test('needs-you and recent DMs rank first; arrows and Enter drive it', async ({ page }) => {
    await openSeeded(page, DMS);
    // Visit beta then gamma through the switcher, so gamma is the most recent.
    for (const id of ['b', 'c']) {
      await page.evaluate((x) => window.__PR_STORE__!.openDm(x), id);
    }
    await page.evaluate(() =>
      window.__PR_MOCK__!.emitPrompt('d', {
        promptId: 'p1',
        kind: 'permission',
        toolName: 'Bash',
        toolInput: {},
      }),
    );
    await page.keyboard.press('Meta+k');
    const names = await options(page).locator('.palette__name').allTextContents();
    expect(names).toEqual(['delta-infra', 'gamma-docs', 'beta-web', 'alpha-api']);
    await expect(options(page).first()).toContainText('Needs you');
    // Keyboard only: Down, Down, Enter opens the third row.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(options(page).nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    expect(await active(page)).toBe('b');
    // Cmd+K again closes it.
    await page.keyboard.press('Meta+k');
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toBeVisible();
    await page.keyboard.press('Meta+k');
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toHaveCount(0);
  });

  test('the title bar field opens it too', async ({ page }) => {
    await openSeeded(page, DMS);
    await page.getByRole('button', { name: 'Jump to a session' }).click();
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toBeVisible();
  });
});

test.describe('workspace: keyboard jumps (checklist 4)', () => {
  test('Cmd+Shift+A opens the DM that has waited longest on the user', async ({ page }) => {
    await openSeeded(page, DMS);
    await page.evaluate(async () => {
      const m = window.__PR_MOCK__!;
      m.emitPrompt('c', { promptId: 'p-old', kind: 'permission', toolName: 'Bash', toolInput: {} });
      await new Promise((r) => setTimeout(r, 15));
      m.emitPrompt('b', { promptId: 'p-new', kind: 'permission', toolName: 'Edit', toolInput: {} });
    });
    await page.keyboard.press('Meta+Shift+A');
    await expect.poll(() => active(page)).toBe('c');
    // Answer it; the next press goes to the remaining one.
    await page.evaluate(() => window.__PR_MOCK__!.resolvePrompt('c', 'p-old', 'terminal'));
    await page.keyboard.press('Meta+Shift+A');
    await expect.poll(() => active(page)).toBe('b');
  });

  test('Option+Shift+Down and Up walk the unread DMs', async ({ page }) => {
    await openSeeded(page, DMS);
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      // Needs-you holds when a DM is viewed; unread would clear on the first visit.
      m.setBadges('b', 0, true);
      m.setBadges('d', 0, true);
    });
    await page.evaluate(() => window.__PR_STORE__!.openDm('a'));
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect.poll(() => active(page)).toBe('b');
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect.poll(() => active(page)).toBe('d');
    // Read DMs are skipped; Up goes back.
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await expect.poll(() => active(page)).toBe('b');
  });
});

test.describe('workspace: Activity view (checklist 5)', () => {
  test('lists prompts and unread turns oldest first, opens at the message, rows vanish when answered', async ({
    page,
  }) => {
    await openSeeded(page, DMS.slice(0, 3));
    const t0 = Date.parse('2026-10-13T09:00:00Z');
    await page.evaluate(
      async ({ t0 }) => {
        const m = window.__PR_MOCK__!;
        const mk = (k: string, i: number, text: string) => ({
          key: k,
          ts: t0 + i * 60_000,
          kind: 'assistant' as const,
          text,
        });
        m.seedChat('a', [
          { key: 'a-u', ts: t0, kind: 'user', text: 'run it', images: [] },
          mk('a-1', 1, 'First unread reply in alpha'),
          mk('a-2', 2, 'Second unread reply in alpha'),
        ]);
        m.setBadges('a', 2, false);
        m.seedChat('b', [
          { key: 'b-u', ts: t0, kind: 'user', text: 'edit it', images: [] },
          {
            key: 'b-tool',
            ts: t0 + 30_000,
            kind: 'tool',
            toolUseId: 'tu-b',
            name: 'Bash',
            input: { command: 'ls' },
            state: 'pending',
          },
        ]);
        m.emitPrompt('b', {
          promptId: 'pb',
          kind: 'permission',
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          toolUseId: 'tu-b',
        });
      },
      { t0 },
    );
    await page.getByTestId('nav-activity').click();
    const rows = page.getByTestId('activity').locator('.actrow');
    await expect(rows).toHaveCount(2);
    // Oldest first: beta's prompt was announced just now (Date.now), alpha's unread is from 2026-10-13.
    const kinds = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));
    const ts = await page.evaluate(() =>
      window.__PR_STORE__!.getSnapshot().activity.map((r) => r.kind),
    );
    expect(kinds).toEqual(ts);
    expect(kinds[0]).toBe('unread');
    // The unread row opens alpha scrolled to the first unread reply, highlighted.
    await rows.first().click();
    await expect(page.getByTestId('activity')).toHaveCount(0);
    await expect(page.locator('.msg[data-key="a-1"]')).toBeVisible();
    await expect(page.locator('.msg[data-key="a-1"]')).toHaveAttribute('data-hit', 'true');
    // Viewing alpha read it, so its row is gone; the prompt row stays until it is answered.
    await page.getByTestId('nav-activity').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-kind', 'prompt');
    await page.evaluate(() => window.__PR_MOCK__!.resolvePrompt('b', 'pb', 'chat'));
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('activity')).toContainText('Nothing is waiting on you.');
  });

  test('a prompt row opens its DM at the pending prompt', async ({ page }) => {
    await openSeeded(page, DMS.slice(0, 2));
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      m.seedChat('b', m.bigChat(400));
      m.emitPrompt('b', { promptId: 'pq', kind: 'permission', toolName: 'Bash', toolInput: {} });
    });
    await page.getByTestId('nav-activity').click();
    await page.getByTestId('activity').locator('.actrow[data-kind="prompt"]').click();
    await expect(page.locator('.ask[data-state="pending"]')).toBeVisible();
  });

  test('the empty state says nothing is waiting', async ({ page }) => {
    await openSeeded(page, DMS.slice(0, 1));
    await page.getByTestId('nav-activity').click();
    await expect(page.getByTestId('activity')).toContainText('Nothing is waiting on you.');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('activity')).toHaveCount(0);
  });
});

test.describe('workspace: Cmd+K first messages and message search', () => {
  /** History rows that tie open DMs to their first message. */
  async function seedFirstMessages(page: Page) {
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      const base = m.historyRows[0];
      m.historyRows = [
        {
          ...base,
          sessionId: 'h-a',
          dmId: 'a',
          firstPrompt: 'Fix the login race in the auth flow',
        },
        { ...base, sessionId: 'h-b', dmId: 'b', firstPrompt: 'Make the header sticky on scroll' },
        { ...base, sessionId: 'h-c', dmId: 'c', firstPrompt: 'Document the infra deploy steps' },
      ];
    });
    await page.evaluate(() => window.__PR_STORE__!.loadHistory());
  }

  test('an open session matches whole words of its first message', async ({ page }) => {
    await openSeeded(page, DMS);
    await seedFirstMessages(page);
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('login race');
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText('alpha-api');
    await expect(options(page).first().getByTestId('qs-prompt')).toContainText(
      'Fix the login race',
    );
    await expect(options(page).first().locator('[data-testid="qs-prompt"] mark')).toHaveText([
      'login',
      'race',
    ]);
    // Letters scattered across words are not a first-message match.
    await page.getByRole('combobox', { name: 'Jump to a session' }).fill('lgnrc');
    await expect(options(page)).toHaveCount(0);
    // A word inside a longer word is not a whole word; the last word may be a prefix.
    await page.getByRole('combobox', { name: 'Jump to a session' }).fill('ticky header');
    await expect(options(page)).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Jump to a session' }).fill('header stick');
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText('beta-web');
  });

  test('a name match ranks above a first-message match', async ({ page }) => {
    await openSeeded(page, DMS);
    await seedFirstMessages(page);
    // "infra" names delta-infra and sits in gamma-docs' first message.
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('infra');
    const names = await options(page).locator('.palette__name').allTextContents();
    expect(names).toEqual(['delta-infra', 'gamma-docs']);
    await expect(options(page).nth(1).getByTestId('qs-prompt')).toBeVisible();
  });

  test('the last row searches messages for the query', async ({ page }) => {
    await openSeeded(page, DMS);
    await page.keyboard.press('Meta+k');
    await expect(searchRow(page)).toHaveCount(0);
    await page.keyboard.type('zebrafish');
    await expect(options(page)).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toContainText(
      'No session matches.',
    );
    await expect(searchRow(page)).toContainText('Search messages for “zebrafish”');
    await expect(searchRow(page)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Quick switcher' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Search messages' })).toHaveValue('zebrafish');
    // With matches, it is still the last row, reachable by arrows.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('beta');
    await page.keyboard.press('ArrowDown');
    await expect(searchRow(page)).toHaveAttribute('aria-selected', 'true');
    await searchRow(page).click();
    await expect(page.getByRole('textbox', { name: 'Search messages' })).toHaveValue('beta');
  });
});
