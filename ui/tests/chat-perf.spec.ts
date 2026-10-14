import { expect, test } from '@playwright/test';
import { openWithDm, sweepLog, watchErrors } from './helpers';

// A 10,000-item transcript opens in under a second, renders a window of rows, and scrolls smoothly.

const N = 10_000;

type Chats = Record<string, { reload(): Promise<void>; apply(items: unknown[]): void }>;

test.describe('virtualized log', () => {
  test('a 10,000-item transcript opens in under 1 s with a small DOM', async ({ page }) => {
    const errs = watchErrors(page);
    const id = await openWithDm(page, 'mock', 'chat');
    const ms = await page.evaluate(
      async ([sid, n]) => {
        const m = window.__PR_MOCK__!;
        m.seedChat(sid as string, m.bigChat(n as number));
        const t0 = performance.now();
        await (window as unknown as { __PR_CHATS__: Chats }).__PR_CHATS__[sid as string].reload();
        // First painted row: two frames after the data is in.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rows = document.querySelectorAll('.vrow').length;
        if (rows === 0) throw new Error('no rows rendered');
        return performance.now() - t0;
      },
      [id, N] as const,
    );
    expect(ms).toBeLessThan(1000);
    await expect(page.locator('.msg[data-key="b-9999"]')).toBeVisible();
    const rendered = await page
      .getByTestId('chat-log')
      .evaluate((el) => el.querySelectorAll('.vrow').length);
    expect(rendered).toBeLessThan(80);
    expect(errs).toEqual([]);
  });

  test('all 10,000 items arriving at once still open fast and scroll at frame rate', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    const id = await openWithDm(page, 'mock', 'chat');
    const t = await page.evaluate(
      async ([sid, n]) => {
        const m = window.__PR_MOCK__!;
        const items = m.bigChat(n as number);
        const t0 = performance.now();
        (window as unknown as { __PR_CHATS__: Chats }).__PR_CHATS__[sid as string].apply(items);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return performance.now() - t0;
      },
      [id, N] as const,
    );
    expect(t).toBeLessThan(1000);
    const log = page.getByTestId('chat-log');
    expect(Number(await log.getAttribute('data-rows'))).toBeGreaterThanOrEqual(N);
    expect(Number(await log.getAttribute('data-rendered'))).toBeLessThan(80);

    // Scroll from the bottom up through the log for 3 s, one wheel-sized step per frame.
    const frames = await log.evaluate(
      (el) =>
        new Promise<number[]>((resolve) => {
          const deltas: number[] = [];
          let last = performance.now();
          const t0 = last;
          const step = (now: number) => {
            deltas.push(now - last);
            last = now;
            el.scrollTop = Math.max(0, el.scrollTop - 90);
            if (now - t0 < 3000 && el.scrollTop > 0) requestAnimationFrame(step);
            else resolve(deltas);
          };
          requestAnimationFrame(step);
        }),
    );
    expect(frames.length).toBeGreaterThan(60);
    const sorted = [...frames].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const slow = frames.filter((d) => d > 50).length / frames.length;
    // 60 fps is 16.7 ms. Headless CI is noisy, so the bar is a p95 under two frames.
    expect(p95, `p95 frame ${p95.toFixed(1)} ms`).toBeLessThan(34);
    expect(slow, `share of frames over 50 ms: ${slow.toFixed(3)}`).toBeLessThan(0.03);
    expect(await log.evaluate((el) => el.querySelectorAll('.vrow').length)).toBeLessThan(80);
    expect(errs).toEqual([]);
  });

  test('sweeping the whole log shows every message exactly once, in order', async ({ page }) => {
    const id = await openWithDm(page, 'mock', 'chat');
    await page.evaluate(
      ([sid, n]) => {
        const m = window.__PR_MOCK__!;
        (window as unknown as { __PR_CHATS__: Chats }).__PR_CHATS__[sid as string].apply(
          m.bigChat(n as number),
        );
      },
      [id, 1500] as const,
    );
    const seen = await sweepLog(page);
    const items = seen.keys.filter((k) => k.startsWith('b-'));
    expect(items.length).toBe(1500);
    expect(items).toEqual(Array.from({ length: 1500 }, (_, i) => `b-${i}`));
    expect(seen.maxRendered).toBeLessThan(80);
  });
});
