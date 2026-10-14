import { expect, test, type Page } from '@playwright/test';
import {
  bytes,
  drain,
  openChat,
  openWithDm,
  peekWrites,
  seedChat,
  takeWrites,
  watchErrors,
} from './helpers';

// Composer, Stop, Cmd+J, badges, status strip, scroll behavior.

const texts = (page: Page) => page.evaluate(() => window.__PR_MOCK__!.texts.map((t) => t.text));

test.describe('composer', () => {
  test('Enter sends exactly what was typed; Shift+Enter adds a line', async ({ page }) => {
    const errs = watchErrors(page);
    const id = await openChat(page, []);
    const box = page.getByTestId('composer-input');
    await box.click();
    await box.pressSequentially('first line');
    await page.keyboard.press('Shift+Enter');
    await box.pressSequentially('second  line  ');
    expect(await texts(page)).toEqual([]); // nothing sent by Shift+Enter
    await page.keyboard.press('Enter');
    expect(await texts(page)).toEqual(['first line\nsecond  line  ']);
    await expect(box).toHaveValue('');
    // The transcript tail echoes it back: exactly one user message.
    await expect(page.locator('.msg[data-kind="user"]')).toHaveCount(1);
    await expect(page.locator('.msg[data-kind="user"]')).toContainText('second  line');
    const sent = await page.evaluate(() => window.__PR_MOCK__!.texts);
    expect(sent[0].id).toBe(id);
    expect(errs).toEqual([]);
  });

  test('slash commands pass through as text, and empty input sends nothing', async ({ page }) => {
    await openChat(page, []);
    const box = page.getByTestId('composer-input');
    await box.click();
    await page.keyboard.press('Enter');
    await box.fill('   ');
    await page.keyboard.press('Enter');
    expect(await texts(page)).toEqual([]);
    await box.fill('/compact keep the diff');
    await page.keyboard.press('Enter');
    expect(await texts(page)).toEqual(['/compact keep the diff']);
    await page.getByRole('button', { name: 'Slash commands' }).click();
    await expect(box).toHaveValue('/');
  });

  test('the send button sends and is disabled while empty', async ({ page }) => {
    await openChat(page, []);
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    await page.getByTestId('composer-input').fill('hello');
    await send.click();
    expect(await texts(page)).toEqual(['hello']);
  });

  test('the draft survives switching DMs', async ({ page }) => {
    await openChat(page, []);
    await page.getByTestId('composer-input').fill('half a thought');
    await page.evaluate(() => {
      window.__PR_MOCK__!.addSession({ cwd: '/tmp/other', name: 'other' });
      return window.__PR_STORE__!.refresh();
    });
    await page.getByRole('button', { name: /other/ }).first().click();
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    await page
      .getByRole('button', { name: /patchroom-test/ })
      .first()
      .click();
    await expect(page.getByTestId('composer-input')).toHaveValue('half a thought');
  });

  test('Stop is visible while busy, sends Esc, and is gone when idle', async ({ page }) => {
    const id = await openChat(page, []);
    await expect(page.getByTestId('stop')).toHaveCount(0);
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'busy'), id);
    const stop = page.getByTestId('stop');
    await expect(stop).toBeVisible();
    await takeWrites(page, id);
    await stop.click();
    expect(await takeWrites(page, id)).toEqual([0x1b]);
    // Esc in the composer is the same interrupt.
    await page.getByTestId('composer-input').click();
    await page.keyboard.press('Escape');
    expect(await takeWrites(page, id)).toEqual([0x1b]);
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'idle'), id);
    await expect(stop).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(await takeWrites(page, id)).toEqual([]);
  });

  test('an ended session disables the composer', async ({ page }) => {
    const id = await openChat(page, []);
    await page.evaluate((sid) => window.__PR_MOCK__!.exit(sid, 0), id);
    await expect(page.getByTestId('composer-input')).toBeDisabled();
    await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', /has ended/);
  });

  test('a pasted clipboard image reaches claude as Ctrl+V; a pasted file path is inserted', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    const box = page.getByTestId('composer-input');
    await box.click();
    await takeWrites(page, id);
    // A bitmap with no path: claude reads it off the system clipboard on Ctrl+V.
    await box.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }),
      );
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });
    expect(await takeWrites(page, id)).toEqual([0x16]);
    await expect(page.getByText('1 image attached from the clipboard')).toBeVisible();
    // A file that has an absolute path: the path goes into the text, as V8 pastes it.
    await box.evaluate((el) => {
      const file = new File([new Uint8Array([1])], 'My Shot.png', { type: 'image/png' });
      Object.defineProperty(file, 'path', { value: '/Users/me/Desktop/My Shot.png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });
    await expect(box).toHaveValue('/Users/me/Desktop/My\\ Shot.png ');
    expect(await takeWrites(page, id)).toEqual([]);
    await box.pressSequentially('what is this');
    await page.keyboard.press('Enter');
    expect(await texts(page)).toEqual(['/Users/me/Desktop/My\\ Shot.png what is this']);
    await expect(page.getByText('image attached from the clipboard')).toHaveCount(0);
  });

  test('plain text paste is left to the textarea', async ({ page }) => {
    const id = await openChat(page, []);
    const box = page.getByTestId('composer-input');
    await box.click();
    await takeWrites(page, id);
    await box.evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'pasted words');
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });
    expect(await takeWrites(page, id)).toEqual([]);
  });
});

test.describe('chat and terminal toggle', () => {
  test('Cmd+J flips both ways and loses no terminal bytes or scrollback', async ({ page }) => {
    const id = await openWithDm(page, 'mock&grid=100x30', 'chat');
    await seedChat(page, id);
    // Fill more than a screen of scrollback while the chat is showing.
    await page.evaluate((sid) => {
      for (let i = 0; i < 80; i++) window.__PR_MOCK__!.emitText(sid, `scrollback line ${i}\r\n`);
    }, id);
    await drain(page, id);
    const read = () =>
      page.evaluate((sid) => {
        const t = (
          window as unknown as {
            __PR_TERMS__: Record<
              string,
              {
                term: {
                  buffer: {
                    active: {
                      length: number;
                      getLine(i: number): { translateToString(): string } | undefined;
                    };
                  };
                };
              }
            >;
          }
        ).__PR_TERMS__[sid];
        const b = t.term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
        return lines.join('\n');
      }, id);
    const before = await read();
    expect(before).toContain('scrollback line 79');
    expect(before).toContain('scrollback line 0');
    const sameInstance = await page.evaluate((sid) => {
      const w = window as unknown as { __PR_TERMS__: Record<string, object>; __keep?: object };
      w.__keep = w.__PR_TERMS__[sid];
      return true;
    }, id);
    expect(sameInstance).toBe(true);

    await page.getByTestId('composer-input').click();
    await page.keyboard.press('Meta+j'); // from the composer
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await expect(page.locator('.term--active .xterm')).toBeVisible();
    await expect(page.getByTestId('chat')).toBeHidden();
    // Bytes arriving while the terminal shows land in the same buffer.
    await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, 'while on terminal\r\n'), id);
    await drain(page, id);
    await page.keyboard.press('Meta+j'); // from the terminal
    await expect(page.getByTestId('view-label')).toHaveText('Chat');
    await expect(page.getByTestId('chat')).toBeVisible();
    await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, 'while on chat\r\n'), id);
    await drain(page, id);
    const after = await read();
    expect(after.startsWith(before.replace(/\n+$/, ''))).toBe(true);
    expect(after).toContain('while on terminal');
    expect(after).toContain('while on chat');
    const same = await page.evaluate((sid) => {
      const w = window as unknown as { __PR_TERMS__: Record<string, object>; __keep?: object };
      return w.__PR_TERMS__[sid] === w.__keep;
    }, id);
    expect(same).toBe(true);
    // The view switch does the same.
    await page
      .getByTestId('view-toggle')
      .getByRole('button', { name: 'Terminal', exact: true })
      .click();
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page
      .getByTestId('view-toggle')
      .getByRole('button', { name: 'Chat', exact: true })
      .click();
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('toggling keeps the chat scroll position and the typed draft', async ({ page }) => {
    await openChat(page);
    const log = page.getByTestId('chat-log');
    await log.evaluate((el) => (el.scrollTop = 500));
    // Rows above the view are measured as they render; the log settles on its own anchor.
    await page.waitForTimeout(300);
    const before = await log.evaluate((el) => el.scrollTop);
    await page.getByTestId('composer-input').fill('unsent');
    await page.keyboard.press('Meta+j');
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('composer-input')).toHaveValue('unsent');
    const top = await log.evaluate((el) => el.scrollTop);
    expect(Math.abs(top - before)).toBeLessThan(2);
  });

  test('toggling does not resize the terminal', async ({ page }) => {
    const id = await openWithDm(page, 'mock', 'chat');
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => window.__PR_MOCK__!.resizes.length);
    await page.keyboard.press('Meta+j');
    await page.keyboard.press('Meta+j');
    await page.keyboard.press('Meta+j');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__PR_MOCK__!.resizes.length);
    expect(after).toBe(before);
    expect(id).toBeTruthy();
  });

  test('the backend is told which view shows', async ({ page }) => {
    const id = await openWithDm(page, 'mock', 'chat');
    const views = () => page.evaluate(() => window.__PR_MOCK__!.views);
    await page.keyboard.press('Meta+j');
    await page.keyboard.press('Meta+j');
    expect(await views()).toEqual([
      { id, view: 'terminal' },
      { id, view: 'chat' },
    ]);
    // Leaving a DM while its terminal shows counts as hiding it.
    await page.keyboard.press('Meta+j');
    const other = await page.evaluate(async () => {
      const s = window.__PR_MOCK__!.addSession({ cwd: '/tmp/second', name: 'second' });
      await window.__PR_STORE__!.refresh();
      return s.id;
    });
    await page.locator('.side .row', { hasText: 'second' }).click();
    const all = await views();
    expect(all.slice(-2)).toEqual([
      { id, view: 'terminal' },
      { id, view: 'chat' },
    ]);
    expect(other).toBeTruthy();
  });

  test('Ctrl+J still reaches the terminal as a newline', async ({ page }) => {
    const id = await openWithDm(page, 'mock&grid=100x30');
    await takeWrites(page, id);
    await page.keyboard.press('Control+j');
    await expect.poll(() => peekWrites(page, id)).toBe(bytes('\n').join(','));
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
  });
});

test.describe('badges', () => {
  async function two(page: Page) {
    const a = await openChat(page, []);
    const b = await page.evaluate(async () => {
      const s = window.__PR_MOCK__!.addSession({ cwd: '/tmp/second', name: 'second' });
      await window.__PR_STORE__!.refresh();
      return s.id;
    });
    return { a, b };
  }
  const row = (page: Page, name: string) => page.locator('.side .row', { hasText: name });

  test('needs-you stays until the prompt is answered, not until it is viewed', async ({ page }) => {
    const { a, b } = await two(page);
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.emitPrompt(sid, {
        promptId: 'p1',
        kind: 'permission',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      });
    }, a);
    await expect(row(page, 'patchroom-test').locator('.bdg.needs')).toHaveText('1');
    // Away and back: still there, and viewing it did not clear it.
    await row(page, 'second').click();
    await expect(row(page, 'patchroom-test').locator('.bdg.needs')).toHaveText('1');
    await row(page, 'patchroom-test').click();
    await expect(page.locator('.ask[data-state="pending"]')).toBeVisible();
    await expect(row(page, 'patchroom-test').locator('.bdg.needs')).toHaveText('1');
    expect(await page.evaluate((sid) => window.__PR_MOCK__!.badges(sid).needsYou, a)).toBe(true);
    // Marking read does not touch needs-you.
    await page.evaluate((sid) => window.__PR_STORE__!.markRead(sid), a);
    await expect(row(page, 'patchroom-test').locator('.bdg.needs')).toHaveText('1');
    // Answering clears it.
    await page.locator('.ask').getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(row(page, 'patchroom-test').locator('.bdg.needs')).toHaveCount(0);
    expect(b).toBeTruthy();
  });

  test('needs-you clears when the terminal answers', async ({ page }) => {
    const { a } = await two(page);
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.emitPrompt(sid, {
        promptId: 'p1',
        kind: 'permission',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      });
    }, a);
    await expect(row(page, 'patchroom-test').locator('.bdg.needs')).toHaveText('1');
    await page.evaluate((sid) => window.__PR_MOCK__!.resolvePrompt(sid, 'p1', 'terminal'), a);
    await expect(row(page, 'patchroom-test').locator('.bdg.needs')).toHaveCount(0);
  });

  test('a background DM gets an unread badge that clears on view', async ({ page }) => {
    const { b } = await two(page);
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.pushItems(sid, [
        { key: 'u1', ts: Date.now(), kind: 'assistant', text: 'finished' },
        { key: 'u2', ts: Date.now(), kind: 'assistant', text: 'and more' },
      ]);
    }, b);
    const r = row(page, 'second');
    await expect(r.locator('.bdg.unr')).toHaveText('2');
    await expect(r).toHaveClass(/unread/);
    await r.click();
    await expect(r.locator('.bdg.unr')).toHaveCount(0);
    await expect(r).not.toHaveClass(/unread/);
    await expect
      .poll(() => page.evaluate((sid) => window.__PR_MOCK__!.badges(sid).unread, b))
      .toBe(0);
    expect(await page.evaluate(() => window.__PR_MOCK__!.marks)).toContain(b);
    // New items in the open DM never leave a lingering badge.
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.pushItems(sid, [
        { key: 'u3', ts: Date.now(), kind: 'assistant', text: 'live' },
      ]);
    }, b);
    await expect(r.locator('.bdg.unr')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate((sid) => window.__PR_MOCK__!.badges(sid).unread, b))
      .toBe(0);
  });

  test('persisted counts from session_list show on launch', async ({ page }) => {
    await page.goto('/?mock');
    await page.evaluate(async () => {
      const m = window.__PR_MOCK__!;
      const s = m.addSession({ cwd: '/tmp/restored', name: 'restored' });
      const list = m.sessions();
      (list.find((x) => x.id === s.id) as unknown as Record<string, number>).unread = 3;
      (list.find((x) => x.id === s.id) as unknown as Record<string, boolean>).needsYou = true;
      await window.__PR_STORE__!.refresh();
    });
    const r = row(page, 'restored');
    await expect(r.locator('.bdg.needs')).toHaveText('1');
    await expect(r.locator('.bdg.unr')).toHaveText('3');
    await r.click();
    await expect(r.locator('.bdg.unr')).toHaveCount(0);
    await expect(r.locator('.bdg.needs')).toHaveText('1'); // viewing never clears needs-you
  });

  test('the title bar Needs you button counts DMs with prompts', async ({ page }) => {
    const { a } = await two(page);
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.emitPrompt(sid, {
        promptId: 'p1',
        kind: 'permission',
        toolName: 'Bash',
        toolInput: {},
      });
    }, a);
    await expect(page.locator('.tb-act b')).toHaveText('1');
  });
});

test.describe('status strip', () => {
  test('renders the user statusLine as ANSI, verbatim, plus chips', async ({ page }) => {
    const id = await openChat(page, []);
    const raw =
      '\x1b[36mpatchroom\x1b[0m  \x1b[1;32mfeat/p2\x1b[0m   \x1b[38;5;208mtests: 42 ok\x1b[0m\x1b[38;2;10;20;30m!\x1b[0m';
    await page.evaluate(
      ([sid, text]) =>
        window.__PR_MOCK__!.setStatusline(sid, text, {
          model: 'Opus 4.8',
          contextPct: 64,
          cost: 1.82,
          mode: 'accept edits',
          worktree: 'wt/hook-bridge',
          prUrl: 'https://github.com/acme/patchroom/pull/14',
        }),
      [id, raw],
    );
    const line = page.getByTestId('statusline');
    await expect(line).toBeVisible();
    // Same bytes as text: escapes gone, spacing kept.
    expect(await line.evaluate((el) => el.textContent)).toBe('patchroom  feat/p2   tests: 42 ok!');
    const style = (text: string) =>
      line
        .locator('span', { hasText: text })
        .first()
        .evaluate((e) => ({
          color: getComputedStyle(e).color,
          weight: getComputedStyle(e).fontWeight,
        }));
    expect((await style('patchroom')).color).toBe('rgb(0, 197, 199)');
    expect((await style('feat/p2')).color).toBe('rgb(0, 194, 0)');
    expect((await style('tests: 42 ok')).color).toBe('rgb(255, 135, 0)');
    expect((await style('!')).color).toBe('rgb(10, 20, 30)');
    const bold = (await style('feat/p2')).weight;
    expect(Number(bold)).toBeGreaterThanOrEqual(600);
    const strip = page.getByTestId('status-strip');
    await expect(strip.locator('[data-chip="model"]')).toHaveText('Opus 4.8');
    await expect(strip.locator('[data-chip="folder"]')).toHaveText('patchroom-test');
    await expect(strip.locator('[data-chip="context"]')).toContainText('ctx 64%');
    await expect(strip.locator('[data-chip="cost"]')).toHaveText('$1.82');
    await expect(strip.locator('[data-chip="mode"]')).toHaveText('accept edits');
    await expect(strip.locator('[data-chip="worktree"]')).toHaveText('wt/hook-bridge');
    await expect(strip.locator('[data-chip="pr"]')).toHaveText('PR #14');
    // An update replaces it.
    await page.evaluate(
      (sid) => window.__PR_MOCK__!.setStatusline(sid, 'plain', { model: 'Haiku' }),
      id,
    );
    await expect(line).toHaveText('plain');
    await expect(strip.locator('[data-chip="model"]')).toHaveText('Haiku');
    await expect(strip.locator('[data-chip="mode"]')).toHaveCount(0);
  });

  test('multi-line statusLine output keeps its lines and padding', async ({ page }) => {
    const id = await openChat(page, []);
    await page.evaluate(
      (sid) => window.__PR_MOCK__!.setStatusline(sid, 'line one\n   indented two\n', {}),
      id,
    );
    const lines = page.getByTestId('statusline').locator('.sl-line');
    await expect(lines).toHaveCount(2);
    expect(await lines.nth(1).evaluate((e) => e.textContent)).toBe('   indented two');
  });

  test('with no statusLine the strip shows chips only', async ({ page }) => {
    const id = await openChat(page, []);
    await expect(page.getByTestId('statusline')).toHaveCount(0);
    await expect(page.getByTestId('status-strip').locator('[data-chip="folder"]')).toBeVisible();
    await page.evaluate(
      (sid) => window.__PR_MOCK__!.setStatusline(sid, '', { model: 'Opus 4.8' }),
      id,
    );
    await expect(page.getByTestId('statusline')).toHaveCount(0);
    await expect(page.getByTestId('status-strip').locator('[data-chip="model"]')).toBeVisible();
  });

  test('clicking the mode chip cycles the mode', async ({ page }) => {
    const id = await openChat(page, []);
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatusline(sid, '', { mode: 'plan' }), id);
    await page.locator('[data-chip="mode"]').click();
    await page.locator('[data-chip="mode"]').click();
    expect(await page.evaluate(() => window.__PR_MOCK__!.modeCycles)).toEqual([id, id]);
  });
});

test.describe('log scrolling', () => {
  test('new items stick to the bottom only when the view was at the bottom', async ({ page }) => {
    const id = await openChat(page, undefined);
    const log = page.getByTestId('chat-log');
    const atBottom = () =>
      log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 3);
    await expect.poll(atBottom).toBe(true);
    const push = (n: number) =>
      page.evaluate(
        ([sid, k]) =>
          window.__PR_MOCK__!.pushItems(sid as string, [
            {
              key: `n${k}`,
              ts: Date.now(),
              kind: 'assistant',
              text: `new message ${k}\n\nwith a second paragraph`,
            },
          ]),
        [id, n] as const,
      );
    await push(1);
    await expect(page.locator('.msg[data-key="n1"]')).toBeVisible();
    await expect.poll(atBottom).toBe(true);
    // Scroll up: new items must not drag the view down.
    await log.evaluate((el) => (el.scrollTop = 200));
    await page.waitForTimeout(100);
    await push(2);
    await page.waitForTimeout(200);
    const top = await log.evaluate((el) => el.scrollTop);
    expect(Math.abs(top - 200)).toBeLessThan(4);
    expect(await atBottom()).toBe(false);
    await page.getByTestId('jump-latest').click();
    await expect.poll(atBottom).toBe(true);
    await expect(page.getByTestId('jump-latest')).toHaveCount(0);
    await push(3);
    await expect(page.locator('.msg[data-key="n3"]')).toBeVisible();
  });

  test('a streaming item that grows keeps the bottom pinned', async ({ page }) => {
    const id = await openChat(page, []);
    const log = page.getByTestId('chat-log');
    for (let i = 1; i <= 25; i++) {
      await page.evaluate(
        ([sid, k]) =>
          window.__PR_MOCK__!.pushItems(sid as string, [
            {
              key: 'grow',
              ts: Date.now(),
              kind: 'assistant',
              text: Array.from({ length: k as number }, (_, j) => `line ${j}`).join('\n\n'),
            },
          ]),
        [id, i] as const,
      );
    }
    await expect
      .poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 3))
      .toBe(true);
    await expect(page.locator('.msg[data-key="grow"]')).toContainText('line 24');
    // Same key replaced in place: still one row.
    await expect(page.locator('.msg[data-key="grow"]')).toHaveCount(1);
  });

  test('older pages load when scrolling to the top and keep the view in place', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await page.evaluate(async (sid) => {
      const m = window.__PR_MOCK__!;
      m.seedChat(sid, m.bigChat(1200));
      await (
        window as unknown as { __PR_CHATS__: Record<string, { reload(): Promise<void> }> }
      ).__PR_CHATS__[sid].reload();
    }, id);
    await expect(page.locator('.msg[data-key="b-1199"]')).toBeVisible();
    const calls = () => page.evaluate(() => window.__PR_MOCK__!.historyCalls.length);
    const first = await calls();
    const log = page.getByTestId('chat-log');
    await log.evaluate((el) => (el.scrollTop = 0));
    await expect.poll(calls).toBeGreaterThan(first);
    const hist = await page.evaluate(() => window.__PR_MOCK__!.historyCalls);
    expect(hist[0].before).toBeUndefined();
    expect(typeof hist[hist.length - 1].before).toBe('string');
    // The first visible row stays where it was after the page lands.
    const anchorKey = await log.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const rows = Array.from(el.querySelectorAll<HTMLElement>('.vrow'));
      return rows.find((x) => x.getBoundingClientRect().bottom > r.top + 4)?.dataset.rk ?? '';
    });
    expect(anchorKey).not.toBe('');
  });
});
