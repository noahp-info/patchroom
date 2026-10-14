import type { Page } from '@playwright/test';
import type {} from '../src/ipc/mock'; // brings the `window.__PR_MOCK__` type in

/** Open the app on the mock IPC and start one DM through the real New DM dialog. */
export async function openWithDm(page: Page, query = 'mock&grid=100x30'): Promise<string> {
  await page.goto(`/?${query}`);
  await page.getByRole('button', { name: 'New DM' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New DM' });
  await dlg.getByLabel('Folder').fill('/tmp/patchroom-test');
  await dlg.getByRole('button', { name: 'Start DM' }).click();
  await page
    .locator('[data-testid="terminal"] .xterm-helper-textarea')
    .waitFor({ state: 'attached' });
  const id = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0].id);
  await page.locator('[data-testid="terminal"]').first().click();
  return id;
}

/** Bytes the UI wrote to the session since the last call. */
export async function takeWrites(page: Page, id: string): Promise<number[]> {
  return page.evaluate((sid) => {
    const w = window.__PR_MOCK__!.writes;
    const out = w[sid] ?? [];
    w[sid] = [];
    return out;
  }, id);
}

/** Bytes written so far, without clearing them. Use with `expect.poll`. */
export async function peekWrites(page: Page, id: string): Promise<string> {
  return page.evaluate((sid) => (window.__PR_MOCK__!.writes[sid] ?? []).join(','), id);
}

export function bytes(s: string): number[] {
  return [...new TextEncoder().encode(s)];
}

/** Resolve once xterm has parsed everything written so far. */
export async function drain(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (sid) =>
      new Promise<void>((resolve) => {
        const t = (
          window as unknown as {
            __PR_TERMS__: Record<string, { term: { write(d: string, cb: () => void): void } }>;
          }
        ).__PR_TERMS__[sid];
        t.term.write('', resolve);
      }),
    id,
  );
}
