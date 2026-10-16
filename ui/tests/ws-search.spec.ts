import { expect, test, type Page } from '@playwright/test';
import { openSeeded, watchErrors } from './helpers';

const T0 = Date.parse('2026-10-13T09:00:00Z');

/** A long chat with one distinctive message deep inside it. */
function corpus(needleAt: number, needle: string) {
  return Array.from({ length: 1200 }, (_, i) => ({
    key: `m-${i}`,
    ts: T0 + i * 20_000,
    kind: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text:
      i === needleAt
        ? `Here is the ${needle} we were looking for, in the middle of the log.`
        : `Filler message ${i} about module ${i % 41} and nothing else.`,
    ...(i % 2 === 0 ? { images: [] } : {}),
  }));
}

const dlg = (page: Page) => page.getByRole('dialog', { name: 'Search' });
const results = (page: Page) => dlg(page).getByRole('option');

test.describe('workspace: search UI (checklist 6)', () => {
  test('Cmd+Shift+F searches every DM, highlights the hit and opens the exact message', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    await openSeeded(page, [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
    ]);
    await page.evaluate(
      ({ big, small }) => {
        const m = window.__PR_MOCK__!;
        m.seedChat('a', big as never);
        m.seedChat('b', small as never);
      },
      {
        big: corpus(300, 'zebrafish'),
        small: [{ key: 's-1', ts: T0, kind: 'assistant', text: 'A zebrafish also swims in beta.' }],
      },
    );
    await page.evaluate(() => window.__PR_STORE__!.openDm('b'));
    await page.keyboard.press('Meta+Shift+F');
    await expect(dlg(page)).toBeVisible();
    await page.keyboard.type('zebrafish');
    await expect(results(page)).toHaveCount(2);
    // Each result shows the DM, a time and a highlighted snippet.
    const first = results(page).first();
    await expect(first.locator('b')).toHaveText(/alpha|beta/);
    await expect(first.locator('time')).not.toBeEmpty();
    await expect(first.locator('mark')).toHaveText('zebrafish');
    const alpha = results(page).filter({ hasText: 'alpha' });
    await alpha.click();
    // The DM opens scrolled to the message, and the message is highlighted.
    await expect(dlg(page)).toHaveCount(0);
    const msg = page.locator('.msg[data-key="m-300"]');
    await expect(msg).toBeVisible();
    await expect(msg).toHaveAttribute('data-hit', 'true');
    const inView = await page.evaluate(() => {
      const log = document.querySelector('[data-testid="chat-log"]')!.getBoundingClientRect();
      const r = document.querySelector('.msg[data-key="m-300"]')!.getBoundingClientRect();
      return r.top >= log.top && r.bottom <= log.bottom;
    });
    expect(inView).toBe(true);
    expect(await page.evaluate(() => window.__PR_MOCK__!.locateCalls)).toEqual([
      { id: 'a', itemKey: 'm-300' },
    ]);
    // The window now sits on an older page: a pill returns to the latest messages.
    await page.getByTestId('jump-latest').click();
    await expect(page.locator('.msg[data-key="m-1199"]')).toBeVisible();
    expect(errs).toEqual([]);
  });

  test('Cmd+F searches this DM only', async ({ page }) => {
    await openSeeded(page, [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
    ]);
    await page.evaluate(
      (items) => {
        const m = window.__PR_MOCK__!;
        m.seedChat('a', items as never);
        m.seedChat('b', items as never);
      },
      corpus(10, 'quokka'),
    );
    await page.evaluate(() => window.__PR_STORE__!.openDm('a'));
    await page.keyboard.press('Meta+f');
    await expect(
      dlg(page)
        .getByRole('group', { name: 'Search scope' })
        .getByRole('button', { name: 'This session' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.type('quokka');
    await expect(results(page)).toHaveCount(1);
    await expect(results(page).first().locator('b')).toHaveText('alpha');
    expect((await page.evaluate(() => window.__PR_MOCK__!.searchCalls)).at(-1)?.scope).toEqual({
      id: 'a',
    });
    // Widening the scope finds the other DM too.
    await dlg(page).getByRole('button', { name: 'Everywhere' }).click();
    await expect(results(page)).toHaveCount(2);
    // Arrow keys and Enter drive it.
    await page.getByLabel('Search messages').focus();
    await page.keyboard.press('ArrowDown');
    await expect(results(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page.locator('.msg[data-key="m-10"]')).toHaveAttribute('data-hit', 'true');
    expect(await page.evaluate(() => window.__PR_STORE__!.getSnapshot().activeId)).toBe('b');
  });

  test('a query across 40 DMs returns in under 200 ms', async ({ page }) => {
    const dms = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, name: `dm-${i}` }));
    await openSeeded(page, dms);
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      for (let i = 0; i < 40; i++) {
        m.seedChat(
          `d${i}`,
          Array.from({ length: 250 }, (_, j) => ({
            key: `k-${i}-${j}`,
            ts: Date.now() + j,
            kind: 'assistant' as const,
            text: `Line ${j} of transcript ${i}: ${j === 120 ? 'cassowary' : 'routine output'}`,
          })),
        );
      }
    });
    await page.keyboard.press('Meta+Shift+F');
    const t0 = Date.now();
    await page.keyboard.type('cassowary');
    await expect(results(page)).toHaveCount(40);
    const wall = Date.now() - t0;
    const took = Number(
      (await dlg(page).getByRole('status').textContent())!.match(/in (\d+) ms/)![1],
    );
    expect(took).toBeLessThan(200);
    expect(wall).toBeLessThan(2000);
  });

  test('no match says so; Esc closes', async ({ page }) => {
    await openSeeded(page, [{ id: 'a', name: 'alpha' }]);
    await page.keyboard.press('Meta+Shift+F');
    await page.keyboard.type('nothing-here');
    await expect(dlg(page)).toContainText('No messages match.');
    await page.keyboard.press('Escape');
    await expect(dlg(page)).toHaveCount(0);
  });
});
