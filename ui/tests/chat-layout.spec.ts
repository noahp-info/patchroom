import { expect, test, type Page } from '@playwright/test';
import { openWithDm, revealRow, seedChat } from './helpers';

// Layout sweep for the chat view: 880 to 1400 px, light and dark. Nothing overlaps, clips or runs
// off the pane, including long unbroken strings, wide tables and code, and the open thread pane.

const WIDTHS = [1400, 1250, 1100, 1000, 950, 900, 880];
const SCHEMES = ['light', 'dark'] as const;

const LONG = 'x'.repeat(160);
const LONG_PATH = `/Users/someone/projects/${'deeply/'.repeat(14)}nested/file-with-a-very-long-name.tsx`;

function extraItems(): unknown[] {
  const now = Date.now();
  return [
    {
      key: 'L1',
      ts: now,
      kind: 'user',
      text: `Long token ${LONG} and more words after it.`,
      images: [],
    },
    {
      key: 'L2',
      ts: now,
      kind: 'assistant',
      text: `A path ${LONG_PATH} and a long word ${LONG}.\n\n| one | two | three | four | five | six | seven | eight |\n| - | - | - | - | - | - | - | - |\n| ${LONG} | b | c | d | e | f | g | h |\n\n\`\`\`ts\nconst veryLongLine = "${LONG}${LONG}";\n\`\`\``,
    },
    {
      key: 'L3',
      ts: now,
      kind: 'tool',
      toolUseId: 'tu-long',
      name: 'Read',
      input: { file_path: LONG_PATH },
      state: 'error',
      result: { text: `error: ${LONG}`, isError: true, truncated: false },
    },
    { key: 'L4', ts: now, kind: 'system', subtype: 'api_error', text: `API error ${LONG}` },
    {
      key: 'L5',
      ts: now,
      kind: 'fallback',
      lineType: 'some-very-long-line-type-name',
      summary: `shape ${LONG}`,
    },
  ];
}

async function setup(page: Page): Promise<string> {
  const id = await openWithDm(page, 'mock', 'chat');
  const base = await page.evaluate(() => window.__PR_MOCK__!.synthetic());
  await seedChat(page, id, [...base, ...extraItems()]);
  await page.evaluate(
    ([sid, long]) => {
      const m = window.__PR_MOCK__!;
      m.setStatusline(sid, `\x1b[36m${'status '.repeat(30)}\x1b[0m`, {
        model: 'Opus 4.8 with a long label',
        contextPct: 64,
        cost: 12.34,
        mode: 'bypass permissions on',
        worktree: 'wt/a-long-worktree-name-for-this-session',
        prUrl: 'https://github.com/acme/patchroom/pull/1234',
      });
      m.setStatus(sid, 'busy');
      m.emitPrompt(sid, {
        promptId: 'p-q',
        kind: 'question',
        toolName: 'AskUserQuestion',
        toolInput: {},
        questions: [
          {
            question: `Which of these ${long} should win?`,
            header: 'Pick',
            multiSelect: true,
            options: [
              { label: `Option ${long}`, description: `Detail ${long}` },
              { label: 'Short', description: 'Short detail' },
            ],
          },
        ],
      });
    },
    [id, LONG] as const,
  );
  return id;
}

/** Leaf text boxes that cut their text off with no ellipsis, horizontally or vertically. */
async function silentClips(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const bad: string[] = [];
    document.querySelectorAll<HTMLElement>(`${sel} *`).forEach((el) => {
      if (!el.textContent?.trim() || el.children.length > 0) return;
      if (el.closest('.sr-only')) return;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible')
        return;
      if (
        el.scrollWidth > el.clientWidth + 1 &&
        (cs.textOverflow !== 'ellipsis' || cs.display === 'inline')
      ) {
        bad.push(`${el.className || el.tagName} (x)`);
      }
    });
    return bad;
  }, scope);
}

/** Every rendered row and widget sits inside the log's horizontal bounds. */
async function overflowing(page: Page, logSel: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const log = document.querySelector<HTMLElement>(sel)!;
    const box = log.getBoundingClientRect();
    const bad: string[] = [];
    if (log.scrollWidth > log.clientWidth + 1) bad.push('log scrolls horizontally');
    log.querySelectorAll<HTMLElement>('.vrow *').forEach((el) => {
      // Elements that scroll their own content are allowed to be wider inside; their box is not.
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const inScroller =
        el.closest('.tablewrap, pre, .diffwrap, .tpre, .ask-pre') &&
        !el.matches('.tablewrap, pre, .diffwrap, .tpre, .ask-pre');
      if (inScroller) return;
      if (r.right > box.right + 1 || r.left < box.left - 1)
        bad.push(
          `${el.className || el.tagName} ${Math.round(r.left)}-${Math.round(r.right)} vs ${Math.round(box.left)}-${Math.round(box.right)}`,
        );
    });
    return bad.slice(0, 6);
  }, logSel);
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    test(`chat view fits, ${scheme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await setup(page);
      const at = `${scheme} ${width}px`;
      const log = page.getByTestId('chat-log');
      await expect(page.locator('.ask[data-state="pending"]')).toBeVisible();

      // Frame: chat fills the pane; composer and strip sit inside the window.
      const win = page.viewportSize()!;
      const rect = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
      const pane = await rect('.pane');
      const chat = await rect('.chat');
      expect(chat.x, `chat left, ${at}`).toBeGreaterThanOrEqual(pane.x - 0.5);
      expect(chat.x + chat.width, `chat right, ${at}`).toBeLessThanOrEqual(
        pane.x + pane.width + 0.5,
      );
      for (const sel of ['.composer', '.strip-wrap']) {
        const b = await rect(sel);
        expect(b.x, `${sel} left, ${at}`).toBeGreaterThanOrEqual(chat.x - 0.5);
        expect(b.x + b.width, `${sel} right, ${at}`).toBeLessThanOrEqual(chat.x + chat.width + 0.5);
        expect(b.y + b.height, `${sel} bottom, ${at}`).toBeLessThanOrEqual(win.height + 0.5);
      }
      expect(
        await page.locator('.chat-main').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);

      // Header: the view toggle and chip join the existing groups without overlap.
      const head = await rect('.ch');
      const toggle = await rect('[data-testid="view-toggle"]');
      expect(toggle.x + toggle.width, `toggle inside header, ${at}`).toBeLessThanOrEqual(
        head.x + head.width,
      );
      expect(await page.locator('.ch').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
        true,
      );
      const groups = ['.ch h2', '.ch .fid', '.ch .meta', '.ch .tools'];
      let prev = -Infinity;
      for (const sel of groups) {
        // The view chip gives way to the toggle at 1000px and below.
        if (!(await page.locator(sel).first().isVisible())) continue;
        const b = await rect(sel);
        expect(b.x, `${sel} after previous group, ${at}`).toBeGreaterThanOrEqual(prev - 0.5);
        prev = b.x + b.width;
      }

      // The log, top to bottom: no row runs past the bounds, no leaf text is cut silently.
      await log.evaluate((el) => (el.scrollTop = 0));
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(40);
        expect(
          await overflowing(page, '[data-testid="chat-log"]'),
          `rows inside the log, ${at}, step ${i}`,
        ).toEqual([]);
        expect(await silentClips(page, '.chat'), `silent clips, ${at}, step ${i}`).toEqual([]);
        const moved = await log.evaluate((el) => {
          const b = el.scrollTop;
          el.scrollTop = b + el.clientHeight * 0.8;
          return el.scrollTop !== b;
        });
        if (!moved) break;
      }

      // Ask widget at the bottom: every button inside the widget.
      if (await page.getByTestId('jump-latest').count())
        await page.getByTestId('jump-latest').click();
      const ask = await rect('.ask[data-state="pending"]');
      for (const b of await page.locator('.ask[data-state="pending"] button').all()) {
        const r = (await b.boundingBox())!;
        expect(r.x + r.width, `ask button inside widget, ${at}`).toBeLessThanOrEqual(
          ask.x + ask.width + 0.5,
        );
        expect(r.x, `ask button left, ${at}`).toBeGreaterThanOrEqual(ask.x - 0.5);
      }
      expect(ask.x + ask.width, `ask inside pane, ${at}`).toBeLessThanOrEqual(
        chat.x + chat.width + 0.5,
      );

      // Thread pane: it fits the pane, and the composer stays clear of it when it docks.
      await revealRow(page, 's-sub-1');
      await page.getByTestId('subagent').first().click();
      const thr = page.getByTestId('thread-pane');
      await expect(thr).toBeVisible();
      const t = (await thr.boundingBox())!;
      expect(t.x, `thread left, ${at}`).toBeGreaterThanOrEqual(chat.x - 0.5);
      expect(t.x + t.width, `thread right, ${at}`).toBeLessThanOrEqual(chat.x + chat.width + 0.5);
      expect(await silentClips(page, '.thr'), `thread clips, ${at}`).toEqual([]);
      const conv = chat.width;
      if (conv >= 900) {
        const comp = await rect('.composer');
        expect(comp.x + comp.width, `composer clear of thread, ${at}`).toBeLessThanOrEqual(
          t.x + 0.5,
        );
      }
      expect(
        await overflowing(page, '[data-testid="thread-log"]'),
        `thread rows inside, ${at}`,
      ).toEqual([]);
    });
  }
}

test('chat text never uses a size outside the scale', async ({ page }) => {
  await setup(page);
  const sizes = await page.locator('.chat').evaluate((root) => {
    const out = new Set<string>();
    root.querySelectorAll<HTMLElement>('*').forEach((el) => {
      if (el.closest('svg') || !el.textContent?.trim()) return;
      out.add(getComputedStyle(el).fontSize);
    });
    return [...out].sort();
  });
  // The shell's two-step scale: 13px text and controls, 11px captions.
  for (const s of sizes) expect(['11px', '13px']).toContain(s);
});
