import type { Page } from '@playwright/test';
import type {} from '../src/ipc/mock'; // brings the `window.__PR_MOCK__` type in

/**
 * Open the app on the mock IPC and start one DM through the real New DM dialog. A DM opens as
 * chat; the P1b terminal tests flip to the terminal with Cmd+J, as a user does. Pass
 * `view: 'chat'` to stay on the chat.
 */
export async function openWithDm(
  page: Page,
  query = 'mock&grid=100x30',
  view: 'terminal' | 'chat' = 'terminal',
): Promise<string> {
  await page.goto(`/?${query}`);
  await page.getByRole('button', { name: 'New DM' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New DM' });
  await dlg.getByLabel('Folder').fill('/tmp/patchroom-test');
  await dlg.getByRole('button', { name: 'Start DM' }).click();
  await page
    .locator('[data-testid="terminal"] .xterm-helper-textarea')
    .waitFor({ state: 'attached' });
  if (view === 'chat') await page.getByTestId('chat').waitFor();
  const id = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0].id);
  if (view === 'chat') return id;
  await page.keyboard.press('Meta+j');
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

type MockWindow = Window & {
  __PR_CHATS__?: Record<string, { reload(): Promise<void> }>;
};

/** Seed a DM's chat in the mock and reload it. `items` defaults to the synthetic transcript. */
export async function seedChat(page: Page, id: string, items?: unknown[]): Promise<void> {
  await page.evaluate(
    async ({ sid, list }) => {
      const m = window.__PR_MOCK__!;
      m.seedChat(sid, (list ?? m.synthetic()) as never);
      await (window as MockWindow).__PR_CHATS__![sid].reload();
    },
    { sid: id, list: items ?? null },
  );
}

export interface Swept {
  /** `data-kind` of every row seen. */
  kinds: Set<string>;
  /** Row keys in the order first seen. */
  keys: string[];
  /** Text of every row seen, by key. */
  text: Record<string, string>;
  /** Most rows that were in the DOM at once. */
  maxRendered: number;
}

/**
 * Scroll the virtualized log from top to bottom and collect what rendered on the way. Rows leave
 * the DOM as they scroll out, so this is how a test sees the whole log.
 */
export async function sweepLog(page: Page, root = '[data-testid="chat-log"]'): Promise<Swept> {
  const out = await page.evaluate(async (sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const kinds = new Set<string>();
    const keys: string[] = [];
    const seen = new Set<string>();
    const text: Record<string, string> = {};
    let maxRendered = 0;
    // Wait until rows cover the viewport, so a slow machine never skips a row.
    const covered = () => {
      const rows = el.querySelectorAll<HTMLElement>('.vrow');
      if (rows.length === 0) return el.scrollHeight <= el.clientHeight + 1;
      const box = el.getBoundingClientRect();
      const top = rows[0].getBoundingClientRect().top;
      const bottom = rows[rows.length - 1].getBoundingClientRect().bottom;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const atStart = el.scrollTop <= 1;
      return (top <= box.top + 1 || atStart) && (bottom >= box.bottom - 1 || atEnd);
    };
    const settle = async () => {
      await new Promise<void>((r) => setTimeout(r, 30));
      for (let i = 0; i < 100 && !covered(); i++) await new Promise<void>((r) => setTimeout(r, 20));
    };
    const grab = () => {
      const rows = el.querySelectorAll<HTMLElement>('.vrow');
      maxRendered = Math.max(maxRendered, rows.length);
      rows.forEach((row) => {
        const key = row.dataset.rk!;
        const k = row.querySelector<HTMLElement>('[data-kind]')?.dataset.kind;
        if (k) kinds.add(k);
        text[key] = row.textContent ?? '';
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      });
    };
    el.scrollTop = 0;
    await settle();
    grab();
    for (let guard = 0; guard < 4000; guard++) {
      const before = el.scrollTop;
      el.scrollTop = before + Math.max(120, el.clientHeight * 0.6);
      await settle();
      grab();
      if (el.scrollTop === before) break;
    }
    return { kinds: [...kinds], keys, text, maxRendered };
  }, root);
  return { ...out, kinds: new Set(out.kinds) };
}

/** Open the app with one DM on the chat view and a seeded chat. */
export async function openChat(
  page: Page,
  items?: unknown[],
  query = 'mock&grid=100x30',
): Promise<string> {
  const id = await openWithDm(page, query, 'chat');
  await seedChat(page, id, items);
  return id;
}

/** Fail the test on any console error or uncaught page error. */
export function watchErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  page.on('pageerror', (e) => errs.push(String(e)));
  return errs;
}

/** Scroll the virtualized log until the row with this key is rendered, then center it. */
export async function revealRow(
  page: Page,
  key: string,
  root = '[data-testid="chat-log"]',
): Promise<void> {
  await page.evaluate(
    async ([sel, k]) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const find = () => el.querySelector<HTMLElement>(`.vrow[data-rk="${k}"]`);
      // Wait until rows cover the viewport, so a slow machine never skips past the row.
      const covered = () => {
        const rows = el.querySelectorAll<HTMLElement>('.vrow');
        if (rows.length === 0) return el.scrollHeight <= el.clientHeight + 1;
        const box = el.getBoundingClientRect();
        const top = rows[0].getBoundingClientRect().top;
        const bottom = rows[rows.length - 1].getBoundingClientRect().bottom;
        const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        return (top <= box.top + 1 || el.scrollTop <= 1) && (bottom >= box.bottom - 1 || atEnd);
      };
      const settle = async () => {
        await new Promise<void>((r) => setTimeout(r, 30));
        for (let i = 0; i < 100 && !covered(); i++)
          await new Promise<void>((r) => setTimeout(r, 20));
      };
      el.scrollTop = 0;
      await settle();
      for (let i = 0; i < 400 && !find(); i++) {
        const before = el.scrollTop;
        el.scrollTop = before + el.clientHeight * 0.6;
        await settle();
        if (el.scrollTop === before) break;
      }
      find()?.scrollIntoView({ block: 'center' });
      await settle();
    },
    [root, key] as const,
  );
}
