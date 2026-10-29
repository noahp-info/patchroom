import { expect, test, type Page } from '@playwright/test';
import { openSeeded, watchErrors } from './helpers';

const panel = (page: Page) => page.getByTestId('history');
const groups = (page: Page) => panel(page).locator('.hgroup');

async function openHistory(page: Page, n = 48) {
  await openSeeded(page, [{ id: 'a', name: 'alpha-api', cwd: '/work/alpha-api' }]);
  await page.evaluate((count) => window.__PR_MOCK__!.setHistoryFixture(count), n);
  await page.getByTestId('nav-history').click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('history-count')).toContainText(`${n} sessions`);
}

test.describe('History panel', () => {
  test('groups every session by folder, collapses groups and pages them', async ({ page }) => {
    const errs = watchErrors(page);
    await openHistory(page, 300);
    // Twelve fixture folders, the newest three open.
    await expect(groups(page)).toHaveCount(12);
    const toggles = groups(page).locator('.hgroup__h button');
    await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(toggles.nth(3)).toHaveAttribute('aria-expanded', 'false');
    // 300 over 12 folders: 25 per folder, under one page.
    await expect(groups(page).nth(0).locator('.hrow')).toHaveCount(25);
    // Collapse and reopen.
    await toggles.nth(0).click();
    await expect(groups(page).nth(0).locator('.hrow')).toHaveCount(0);
    await toggles.nth(0).click();
    await expect(groups(page).nth(0).locator('.hrow')).toHaveCount(25);
    expect(errs).toEqual([]);
  });

  test('thousands of sessions render only open groups, a page at a time', async ({ page }) => {
    await openHistory(page, 3000);
    const rows = panel(page).locator('.hrow');
    // Three open groups of 250, each showing one page of 40.
    await expect(rows).toHaveCount(120);
    const first = groups(page).nth(0);
    await first.getByRole('button', { name: /Show 40 more of 210/ }).click();
    await expect(first.locator('.hrow')).toHaveCount(80);
    // The toggle into a grouping with fewer, larger groups stays bounded too.
    const t0 = Date.now();
    await panel(page).getByRole('button', { name: 'Model', exact: true }).click();
    await expect(groups(page)).toHaveCount(4);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await rows.count()).toBeLessThanOrEqual(120);
  });

  test('the grouping toggle is remembered in prefs and search filters within it', async ({
    page,
  }) => {
    await openHistory(page);
    await panel(page).getByRole('button', { name: 'Branch', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.prefs().history?.groupBy))
      .toBe('branch');
    await expect(panel(page).getByRole('button', { name: 'Branch', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(groups(page).locator('.hgroup__name')).toContainText([
      'main',
      'feat/billing',
      'fix/login-race',
      'release/2.4',
      'No branch recorded',
    ]);
    // Search keeps the grouping, opens every matching group and narrows the rows.
    await page.getByTestId('history-filter').fill('webhook');
    await expect(page.getByTestId('history-count')).toContainText('match');
    const titles = await panel(page).locator('.hrow').allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => /webhook/i.test(t))).toBe(true);
    await expect(panel(page).getByRole('button', { name: 'Branch', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The panel opens on the remembered grouping next time.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await page.getByTestId('nav-history').click();
    await expect(panel(page).getByRole('button', { name: 'Branch', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('opening a row resumes it in its folder and marks it open', async ({ page }) => {
    await openHistory(page);
    const row = panel(page).locator('.hrow-wrap').first();
    const sid = await row.getAttribute('data-session');
    await row.locator('.hrow').click();
    await expect(panel(page)).toHaveCount(0);
    const opens = await page.evaluate(() => window.__PR_MOCK__!.historyOpens);
    expect(opens.map((o) => o.sessionId)).toEqual([sid]);
    const active = await page.evaluate(() => window.__PR_STORE__!.getSnapshot().activeId);
    expect(active).toBeTruthy();
    await page.getByTestId('nav-history').click();
    await expect(
      panel(page).locator(`[data-session="${sid}"] [data-testid="history-open-tag"]`),
    ).toBeVisible();
  });

  test('a session live in another terminal asks first and opens as a mirror', async ({ page }) => {
    await openHistory(page);
    await page.getByTestId('history-filter').fill('p95');
    const live = panel(page).locator('.hrow-wrap', { hasText: 'Live elsewhere' }).first();
    await live.locator('.hrow').click();
    await expect(live.getByRole('group', { name: 'Confirm open' })).toBeVisible();
    expect(await page.evaluate(() => window.__PR_MOCK__!.historyOpens.length)).toBe(0);
    await live.getByRole('button', { name: 'Open mirror' }).click();
    await expect(panel(page)).toHaveCount(0);
    const s = await page.evaluate(() => {
      const st = window.__PR_STORE__!.getSnapshot();
      return st.sessions.find((x) => x.id === st.activeId);
    });
    expect(s?.mirror).toBeTruthy();
  });

  test('the first visit shows the hint once, and its button opens Settings > History', async ({
    page,
  }) => {
    await openHistory(page);
    const hint = panel(page).locator('[data-hint="history.group"]');
    await expect(hint).toBeVisible();
    await hint.getByRole('button', { name: 'Open History settings' }).click();
    await expect(page.getByTestId('prefs-history')).toBeVisible();
    await page
      .getByTestId('prefs-history')
      .getByRole('radio', { name: 'Date' })
      .check({ force: true });
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.prefs().history?.groupBy))
      .toBe('date');
    await page.keyboard.press('Escape');
    await page.getByTestId('nav-history').click();
    await expect(panel(page).locator('[data-hint="history.group"]')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Date', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('History grouping logic', () => {
  test('date buckets: today, this week, week numbers, then months', async ({ page }) => {
    await page.goto('/?mock');
    const got = await page.evaluate(async () => {
      const h = await import('/src/lib/history.ts');
      // Wednesday 2026-10-28 15:00 local.
      const now = new Date(2026, 9, 28, 15).getTime();
      const lastWeek = new Date(2026, 9, 21, 9).getTime();
      return {
        today: h.dateBucket(new Date(2026, 9, 28, 9).getTime(), now).label,
        week: h.dateBucket(new Date(2026, 9, 26, 9).getTime(), now).label,
        last: h.dateBucket(lastWeek, now).label,
        july: h.dateBucket(new Date(2026, 6, 4).getTime(), now).label,
        dec: h.dateBucket(new Date(2025, 11, 4).getTime(), now).label,
      };
    });
    expect(got).toEqual({
      today: 'Today',
      week: 'This week',
      last: 'Week 43',
      july: 'July',
      dec: 'December 2025',
    });
  });

  test('groups come newest first and keep every row', async ({ page }) => {
    await page.goto('/?mock');
    const ok = await page.evaluate(async () => {
      const h = await import('/src/lib/history.ts');
      const f = await import('/src/ipc/historyFixture.ts');
      const c = await import('/src/lib/models/catalog.ts');
      const now = new Date(2026, 9, 28, 15).getTime();
      const rows = f.historyFixture(120, now);
      return (['folder', 'date', 'model', 'branch'] as const).every((by) => {
        const g = h.groupHistory(rows, by, c.SHIPPED_CATALOG, now);
        const total = g.reduce((n, b) => n + b.sessions.length, 0);
        return total === 120 && g.every((b, i) => i === 0 || g[i - 1].newest >= b.newest);
      });
    });
    expect(ok).toBe(true);
  });
});
