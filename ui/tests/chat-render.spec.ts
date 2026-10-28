import { expect, test } from '@playwright/test';
import { openChat, openWithDm, seedChat, sweepLog, watchErrors } from './helpers';

// Chat rendering: every ChatItem kind, markdown, tool lines, diffs, thinking, threads, fallback.

const KINDS = [
  'user',
  'assistant',
  'thinking',
  'tool',
  'question',
  'plan',
  'subagent',
  'system',
  'fallback',
];
const STATES = ['pending', 'running', 'ok', 'error', 'denied', 'interrupted'];

test.describe('chat view', () => {
  test('a DM opens as chat, with the terminal mounted underneath', async ({ page }) => {
    const errs = watchErrors(page);
    const id = await openWithDm(page, 'mock&grid=100x30', 'chat');
    await expect(page.getByTestId('chat')).toBeVisible();
    await expect(page.getByTestId('view-label')).toHaveText('Chat');
    await expect(page.getByTestId('chat-empty')).toContainText('No messages yet');
    // The xterm instance exists and is attached, just not shown.
    const mounted = await page.evaluate((sid) => {
      const t = (
        window as unknown as { __PR_TERMS__: Record<string, { term: { element?: HTMLElement } }> }
      ).__PR_TERMS__[sid];
      return !!t.term.element?.isConnected;
    }, id);
    expect(mounted).toBe(true);
    await expect(page.locator('.term .xterm')).toBeHidden();
    expect(errs).toEqual([]);
  });

  test('a prompt cancelled before Claude replied is struck through and tagged Cancelled', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    const t = Date.UTC(2026, 9, 28, 12, 0, 0);
    await openChat(page, [
      {
        key: 'u1',
        ts: t,
        kind: 'user',
        text: 'Write an essay about teal.',
        images: [],
        cancelled: true,
      },
      {
        key: 'u2',
        ts: t + 3000,
        kind: 'user',
        text: 'Write an essay about teal. Keep it short.',
        images: [],
      },
      { key: 'a1', ts: t + 5000, kind: 'assistant', text: 'Teal sits between blue and green.' },
      // Work happened before this interrupt: the prompt stays normal, the turn says Interrupted.
      { key: 'u3', ts: t + 9000, kind: 'user', text: 'Now refactor the parser.', images: [] },
      {
        key: 't1',
        ts: t + 9500,
        kind: 'tool',
        toolUseId: 'tu1',
        name: 'Bash',
        input: { command: 'ls' },
        state: 'interrupted',
      },
      {
        key: 's1',
        ts: t + 9600,
        kind: 'system',
        subtype: 'interrupted',
        text: '[Request interrupted by user]',
      },
    ]);
    const cancelled = page.locator('.msg[data-key="u1"]');
    await expect(cancelled.getByTestId('msg-tag')).toHaveText('Cancelled');
    // Next to the time, in the name line.
    await expect(cancelled.locator('.who time')).toBeVisible();
    const text = cancelled.locator('.usertext');
    await expect(text).toHaveText('Write an essay about teal.');
    await expect(text).toHaveCSS('text-decoration-line', 'line-through');
    expect(await text.evaluate((e) => getComputedStyle(e).userSelect)).not.toBe('none');
    // Screen readers hear the state, not only see a line through the text.
    await expect(cancelled.locator('.body .sr-only')).toHaveText(/Cancelled/);
    // The re-sent prompt is a normal message with its own name line and time.
    const resent = page.locator('.msg[data-key="u2"]');
    await expect(resent).toHaveClass(/head/);
    await expect(resent.getByTestId('msg-tag')).toHaveCount(0);
    await expect(resent.locator('.usertext')).toHaveCSS('text-decoration-line', 'none');
    // A prompt Claude already worked on stays normal.
    await expect(page.locator('.msg[data-key="u3"] [data-testid="msg-tag"]')).toHaveCount(0);
    await expect(page.locator('.msg[data-key="s1"]')).toContainText('Interrupted');
    expect(errs).toEqual([]);
  });

  test('every ChatItem kind and tool state renders', async ({ page }) => {
    const errs = watchErrors(page);
    await openChat(page);
    const seen = await sweepLog(page);
    for (const k of KINDS) expect(seen.kinds, `kind ${k} rendered`).toContain(k);
    const states = await page.evaluate(() =>
      window.__PR_MOCK__!.synthetic().flatMap((i) => (i.kind === 'tool' ? [i.state] : [])),
    );
    for (const s of STATES) expect(states).toContain(s);
    // Each tool state shows through the line's data-state, so it is visible in the DOM.
    const log = page.getByTestId('chat-log');
    const found = new Set<string>();
    await log.evaluate((el) => (el.scrollTop = 0));
    for (let i = 0; i < 40; i++) {
      for (const st of await page
        .locator('[data-testid="tool"]')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state ?? '')))
        found.add(st);
      const moved = await log.evaluate((el) => {
        const b = el.scrollTop;
        el.scrollTop = b + 300;
        return el.scrollTop !== b;
      });
      await page.waitForTimeout(50);
      if (!moved) break;
    }
    for (const s of STATES) expect(found, `tool state ${s}`).toContain(s);
    expect(errs).toEqual([]);
  });

  test('assistant markdown: lists, tables, quotes, links, code with highlighting', async ({
    page,
  }) => {
    await openChat(page);
    const md = page.locator('.msg[data-key="s-asst-1"] .md');
    await md.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 300));
    await expect(md).toBeVisible();
    await expect(md.locator('strong').first()).toHaveText('bridge');
    await expect(md.locator('h3')).toHaveText('What changed');
    await expect(md.locator('ol > li')).toHaveCount(3);
    await expect(md.locator('ol ul > li')).toHaveCount(2);
    await expect(md.locator('table th')).toHaveText(['File', 'Change', 'Lines']);
    await expect(md.locator('table td').first()).toContainText('socket.rs');
    await expect(md.locator('blockquote')).toContainText('Quoted note');
    await expect(md.locator('a[href="https://example.com/docs"]')).toHaveText('link');
    await expect(md.locator('del')).toHaveText('strike');
    // snake_case words are not emphasis.
    await expect(md).toContainText('Snake_case_names stay intact');
    await expect(md.locator('em')).toHaveCount(1);
    await expect(md.locator('input[type=checkbox]')).toHaveCount(2);
    // Task list: the checkbox and its label share one line.
    for (const li of await md.locator('li.task').all()) {
      await li.scrollIntoViewIfNeeded().catch(() => undefined);
      const box = await li.locator('input[type=checkbox]').boundingBox();
      const label = await li.locator('.tp').boundingBox();
      expect(box && label).toBeTruthy();
      const bc = box!.y + box!.height / 2;
      expect(bc).toBeGreaterThan(label!.y);
      expect(bc).toBeLessThan(label!.y + label!.height);
      expect(label!.x).toBeGreaterThan(box!.x + box!.width - 1);
      expect(label!.height).toBeLessThan(30);
    }
    const code = md.locator('pre.code');
    await code.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop += 200));
    await expect(code.locator('.tk-kw').first()).toBeVisible();
    await expect(code.locator('.tk-cm')).toContainText('read one request');
    await expect(code).toHaveAttribute('data-lang', 'rust');
  });

  test('markdown never injects HTML or unsafe links', async ({ page }) => {
    const errs = watchErrors(page);
    const id = await openWithDm(page, 'mock', 'chat');
    await seedChat(page, id, [
      {
        key: 'x1',
        ts: Date.now(),
        kind: 'assistant',
        text: '<img src=x onerror="window.__pwned=1"> and [bad](javascript:alert(1)) and <script>window.__pwned=2</script>',
      },
    ]);
    await expect(page.locator('.msg[data-key="x1"]')).toContainText('<img src=x');
    await expect(page.locator('.msg[data-key="x1"] a')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
    expect(errs).toEqual([]);
  });

  test('a tool call is one line that expands to input and result', async ({ page }) => {
    await openChat(page);
    const log = page.getByTestId('chat-log');
    await log.evaluate((el) => (el.scrollTop = 1100));
    const bash = page.locator('.msg[data-key="s-tool-bash"]');
    await expect(bash).toBeVisible();
    const line = bash.locator('button.tool');
    await expect(line).toContainText('Bash');
    await expect(line).toContainText('pnpm test --filter bridge');
    await expect(line).toHaveAttribute('aria-expanded', 'false');
    const collapsed = (await bash.boundingBox())!.height;
    expect(collapsed).toBeLessThan(60);
    await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'true');
    await expect(bash.locator('.tool-body')).toContainText('Input');
    await expect(bash.locator('.tool-body')).toContainText('PASS  42 tests');
    await expect(bash.locator('.tool-body')).toContainText('Output truncated');
    await line.click();
    await expect(bash.locator('.tool-body')).toHaveCount(0);
  });

  test('Edit and Write show an inline diff with counts', async ({ page }) => {
    await openChat(page);
    const log = page.getByTestId('chat-log');
    await log.evaluate((el) => (el.scrollTop = 800));
    const edit = page.locator('.msg[data-key="s-tool-edit"]');
    await expect(edit).toBeVisible();
    await expect(edit.locator('.tdiff')).toContainText('+3');
    await expect(edit.locator('.tdiff')).toContainText('1');
    await edit.locator('button.tool').click();
    const diff = edit.locator('table.diff');
    await expect(diff).toBeVisible();
    await expect(diff.locator('tr.a')).toHaveCount(3);
    await expect(diff.locator('tr.d')).toHaveCount(1);
    await expect(diff.locator('tr.hunk')).toHaveCount(1);
    await expect(diff.locator('tr.a .tk-kw').first()).toBeVisible();
    // Write: every line is an addition, the trailing newline is not a line.
    const write = page.locator('.msg[data-key="s-tool-write"]');
    await write.scrollIntoViewIfNeeded().catch(() => undefined);
    await expect(write.locator('.tdiff')).toContainText('+3');
  });

  test('thinking is collapsed until opened', async ({ page }) => {
    await openChat(page);
    const row = page.locator('.msg[data-key="s-think-1"]');
    await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 150));
    await expect(row).toBeVisible();
    await expect(row.locator('.think-text')).toHaveCount(0);
    const btn = row.getByRole('button', { name: 'Thinking' });
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await btn.click();
    await expect(row.locator('.think-text')).toContainText('exit 0 with an empty body');
  });

  test('a subagent is a thread summary that opens its items in the right pane', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    const id = await openChat(page);
    await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 1800));
    const sub = page.getByTestId('subagent');
    await expect(sub).toContainText('Subagent: race-check');
    await expect(sub).toContainText('Explore');
    await expect(sub).toContainText('3 items');
    await sub.click();
    const pane = page.getByTestId('thread-pane');
    await expect(pane).toBeVisible();
    await expect(pane).toContainText('No race: the hook drops the late bridge reply.');
    await expect(pane.locator('.msg[data-kind="tool"]')).toContainText('Grep');
    const calls = await page.evaluate(() => window.__PR_MOCK__!.threadCalls);
    expect(calls).toEqual([{ id, toolUseId: 'tu-sub' }]);
    // A live child item lands in the open thread, not in the main log.
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.pushItems(sid, [
        {
          key: 'c-4',
          ts: Date.now(),
          kind: 'assistant',
          text: 'One more finding.',
          parentToolUseId: 'tu-sub',
        },
      ]);
    }, id);
    await expect(pane).toContainText('One more finding.');
    await expect(page.getByTestId('chat-log').locator('.msg[data-key="c-4"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('a fallback row offers View in terminal and opens the terminal', async ({ page }) => {
    await openChat(page);
    await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 2400));
    const fb = page.locator('.msg[data-kind="fallback"]');
    await expect(fb).toContainText('worktree-state');
    await fb.getByRole('button', { name: 'View in terminal' }).click();
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await expect(page.locator('.term--active .xterm')).toBeVisible();
  });

  test('system rows, answered questions and plans read as quiet chrome', async ({ page }) => {
    await openChat(page);
    const seen = await sweepLog(page);
    expect(seen.text['s-sys-1']).toContain('Conversation compacted');
    expect(seen.text['s-sys-2']).toContain('Worked for 2m 14s');
    expect(seen.text['s-q-1']).toContain('30 seconds');
    expect(seen.text['s-q-1']).toContain('Answered');
    expect(seen.text['s-plan-1']).toContain('Add the timeout');
    expect(seen.text['s-plan-1']).toContain('Approved');
  });

  test('user messages show pasted images fetched on demand', async ({ page }) => {
    await openChat(page);
    await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 0));
    const img = page.locator('.msg[data-key="s-user-1"] img.chatimg');
    await expect(img).toBeVisible();
    // The item carries only a ref; the bytes came from chat_image.
    const item = await page.evaluate(() =>
      JSON.stringify(window.__PR_MOCK__!.synthetic().find((i) => i.key === 's-user-1')),
    );
    expect(item).not.toContain('data:');
  });

  test('consecutive items from one author share a header; a new author starts one', async ({
    page,
  }) => {
    await openChat(page);
    const seen = await sweepLog(page);
    expect(seen.keys.length).toBeGreaterThan(10);
    await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 800));
    // Read, Edit, Write follow each other with no repeated "Claude" header between them.
    const edit = page.locator('.msg[data-key="s-tool-edit"]');
    await expect(edit).toBeVisible();
    await expect(edit.locator('.who')).toHaveCount(0);
  });
});
