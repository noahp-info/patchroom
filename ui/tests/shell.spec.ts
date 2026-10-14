import { expect, test } from '@playwright/test';
import { chooseNew, drain, openWithDm } from './helpers';

test.describe('shell', () => {
  test('Homeroom is the default base and the sidebar lists the DM', async ({ page }) => {
    const id = await openWithDm(page, 'mock');
    await expect(page.locator('.pr-app')).toHaveAttribute('data-base', 'homeroom');
    await expect(page.locator('.pr-app')).toHaveAttribute('data-theme', 'homeroom');
    const row = page.locator('.side .row', { hasText: 'patchroom-test' });
    await expect(row).toHaveAttribute('aria-current', 'true');
    expect(id).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Direct messages' })).toBeVisible();
  });

  test('presence dot and title follow the session live', async ({ page }) => {
    const id = await openWithDm(page, 'mock');
    const dot = page.locator('.side .row .dot').first();
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'busy'), id);
    await expect(dot).toHaveClass(/busy/);
    await expect(page.locator('.ch__status')).toHaveText('Working');
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'waiting', 'permission'), id);
    await expect(dot).toHaveClass(/needs/);
    await expect(page.locator('.ch__status')).toHaveText('Needs you: permission');
    await expect(
      page.getByRole('button', { name: 'Needs you', exact: false }).first(),
    ).toBeVisible();
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'idle'), id);
    await expect(dot).toHaveClass(/idle/);
    await page.evaluate((sid) => window.__PR_MOCK__!.setTitle(sid, 'Fix the build'), id);
    await expect(page.getByTestId('term-title')).toHaveText('Fix the build');
  });

  test('an exited DM moves to Ended and offers Resume', async ({ page }) => {
    const id = await openWithDm(page, 'mock');
    await page.evaluate((sid) => window.__PR_MOCK__!.exit(sid, 0), id);
    await expect(page.locator('.side .row')).toHaveAttribute('data-status', 'exited');
    await page.getByRole('button', { name: 'Resume' }).click();
    // Resume uses session_resume on the same DM: no second DM, no --resume via session_create.
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.resumes.map((r) => r.id)))
      .toEqual([id]);
    expect(await page.evaluate(() => window.__PR_MOCK__!.sessions().length)).toBe(1);
    await expect(page.locator('.side .row')).toHaveCount(1);
    await expect(page.locator('.side .row .dot')).toHaveClass(/busy/);
    await expect(page.locator('.ch__status')).toHaveText('Working');
  });

  test('DMs sit under their stored sections with presence and a needs-you signal', async ({
    page,
  }) => {
    await page.goto('/?mock');
    await page.evaluate(() => {
      const m = window.__PR_MOCK__!;
      const work = m.addSection({ id: 'sec-work', name: 'Work', position: 0 });
      m.addSection({ id: 'sec-play', name: 'Side projects', position: 1 });
      m.addSession({ id: 'a', cwd: '/x/alpha', name: 'alpha', sectionId: work.id, status: 'busy' });
      m.addSession({
        id: 'b',
        cwd: '/x/beta',
        name: 'beta',
        sectionId: 'sec-play',
        status: 'waiting',
      });
      m.addSession({ id: 'c', cwd: '/x/gamma', name: 'gamma' });
    });
    // The app already ran session_list on load, so ask it to re-read the seeded backend.
    await page.evaluate(() =>
      (window as unknown as { __PR_STORE__: { refresh(): Promise<void> } }).__PR_STORE__.refresh(),
    );
    const sec = (id: string) => page.locator(`.side [data-section="${id}"]`);
    await expect(sec('sec-work').locator('.row')).toHaveText(/alpha/);
    await expect(sec('sec-play').locator('.row')).toHaveText(/beta/);
    await expect(sec('__default__').locator('.row')).toHaveText(/gamma/);
    await expect(sec('sec-play').locator('.row .dot')).toHaveClass(/needs/);
    await expect(sec('sec-play').locator('.row .bdg')).toBeVisible();
    // Collapsing a stored section persists through section_set_collapsed and keeps the signal.
    await sec('sec-play')
      .getByRole('button', { name: /Side projects/ })
      .click();
    // Collapsing never hides what needs you: the waiting DM stays as a row under the header.
    await expect(sec('sec-play').locator('.row')).toHaveCount(1);
    await expect(sec('sec-play').locator('.row')).toHaveText(/beta/);
    await expect(sec('sec-play').locator('.sec-h .bdg.needs')).toHaveText('1');
    expect(
      await page.evaluate(
        () => window.__PR_MOCK__!.sections().find((s) => s.id === 'sec-play')!.collapsed,
      ),
    ).toBe(true);
  });

  test('moving a DM and adding a section go through the section commands', async ({ page }) => {
    const id = await openWithDm(page, 'mock');
    await chooseNew(page, 'New section');
    await page.getByLabel('Section name').fill('Reviews');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.side [data-section]').filter({ hasText: 'Reviews' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Section' }).selectOption({ label: 'Reviews' });
    await expect
      .poll(() =>
        page.evaluate(
          (sid) => window.__PR_MOCK__!.sessions().find((s) => s.id === sid)!.sectionId,
          id,
        ),
      )
      .toMatch(/^sec-/);
    await expect(
      page.locator('.side [data-section^="sec-"]').filter({ hasText: 'Reviews' }).locator('.row'),
    ).toHaveText(/patchroom-test/);
  });

  test('Browse uses the backend folder picker', async ({ page }) => {
    await page.goto('/?mock');
    await page.evaluate(() => (window.__PR_MOCK__!.pickResult = '/tmp/picked-folder'));
    await chooseNew(page, 'New DM');
    const dlg = page.getByRole('dialog', { name: 'New DM' });
    await dlg.getByRole('button', { name: 'Browse' }).click();
    await expect(dlg.getByLabel('Folder')).toHaveValue('/tmp/picked-folder');
  });

  test('New DM defaults to the last folder', async ({ page }) => {
    await openWithDm(page, 'mock');
    await chooseNew(page, 'New DM');
    await expect(page.getByRole('dialog').getByLabel('Folder')).toHaveValue('/tmp/patchroom-test');
  });

  test('empty state offers New DM', async ({ page }) => {
    await page.goto('/?mock');
    await expect(page.getByRole('heading', { name: 'No DMs yet' })).toBeVisible();
  });
});

test.describe('terminal capabilities', () => {
  test('uses WebGL when available and the DOM renderer otherwise', async ({ page }) => {
    await openWithDm(page, 'mock');
    const renderer = await page
      .locator('[data-testid="terminal"]')
      .first()
      .getAttribute('data-renderer');
    expect(['webgl', 'dom']).toContain(renderer);
    // Either way the terminal paints something.
    await expect(page.locator('.xterm-screen canvas, .xterm-rows').first()).toBeVisible();
  });

  test('Unicode 11 widths: emoji take two cells', async ({ page }) => {
    const id = await openWithDm(page, 'mock&grid=80x24');
    await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, '\x1bc✅ ok \u{1F389}|'), id);
    await drain(page, id);
    const cells = await page.evaluate((sid) => {
      const t = (
        window as unknown as {
          __PR_TERMS__: Record<
            string,
            {
              term: {
                unicode: { activeVersion: string };
                buffer: {
                  active: {
                    getLine(y: number): {
                      getCell(x: number): { getChars(): string; getWidth(): number };
                    };
                  };
                };
              };
            }
          >;
        }
      ).__PR_TERMS__[sid].term;
      const line = t.buffer.active.getLine(0);
      return {
        version: t.unicode.activeVersion,
        widths: [0, 1, 2, 3, 4, 5, 6, 7, 8].map(
          (x) => `${line.getCell(x).getChars()}:${line.getCell(x).getWidth()}`,
        ),
      };
    }, id);
    expect(cells.version).toBe('11');
    expect(cells.widths.slice(0, 2)).toEqual(['✅:2', ':0']);
    expect(cells.widths[6]).toBe('\u{1F389}:2');
    expect(cells.widths[8]).toBe('|:1');
  });

  test('alt screen switches and restores', async ({ page }) => {
    const id = await openWithDm(page, 'mock&grid=80x24');
    const type = () =>
      page.evaluate(
        (sid) =>
          (
            window as unknown as {
              __PR_TERMS__: Record<string, { term: { buffer: { active: { type: string } } } }>;
            }
          ).__PR_TERMS__[sid].term.buffer.active.type,
        id,
      );
    await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, 'main\x1b[?1049halt'), id);
    await drain(page, id);
    expect(await type()).toBe('alternate');
    await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, '\x1b[?1049l'), id);
    await drain(page, id);
    expect(await type()).toBe('normal');
  });

  test('truecolor reaches the buffer as RGB', async ({ page }) => {
    const id = await openWithDm(page, 'mock&grid=80x24');
    await page.evaluate(
      (sid) => window.__PR_MOCK__!.emitText(sid, '\x1bc\x1b[38;2;215;119;87mX'),
      id,
    );
    await drain(page, id);
    const fg = await page.evaluate((sid) => {
      const c = (
        window as unknown as {
          __PR_TERMS__: Record<
            string,
            {
              term: {
                buffer: {
                  active: {
                    getLine(y: number): {
                      getCell(x: number): { isFgRGB(): boolean; getFgColor(): number };
                    };
                  };
                };
              };
            }
          >;
        }
      ).__PR_TERMS__[sid].term.buffer.active
        .getLine(0)
        .getCell(0);
      return c.isFgRGB() ? c.getFgColor() : -1;
    }, id);
    expect(fg).toBe((215 << 16) | (119 << 8) | 87);
  });
});

test.describe('layout stability', () => {
  test('resizing the window never shifts the chrome and refits the terminal', async ({ page }) => {
    const id = await openWithDm(page, 'mock');
    const frame = () =>
      page.evaluate(() => {
        const r = (sel: string) => {
          const b = document.querySelector(sel)!.getBoundingClientRect();
          return [b.x, b.y, b.width, b.height].map(Math.round).join(',');
        };
        return { side: r('.side'), ch: r('.ch'), tb: r('.tb') };
      });
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect
      .poll(() =>
        page.evaluate((sid) => window.__PR_MOCK__!.resizes.filter((r) => r.id === sid).length, id),
      )
      .toBeGreaterThan(0);
    const before = await frame();
    const sizeBefore = await page.evaluate(() => window.__PR_MOCK__!.resizes.at(-1));
    await page.setViewportSize({ width: 1100, height: 700 });
    await expect
      .poll(() => page.evaluate(() => JSON.stringify(window.__PR_MOCK__!.resizes.at(-1))))
      .not.toBe(JSON.stringify(sizeBefore));
    const after = await frame();
    // Sidebar width and the header/title strip heights stay put; only the conversation width changes.
    expect(after.side.split(',')[0]).toBe(before.side.split(',')[0]);
    expect(after.side.split(',')[2]).toBe(before.side.split(',')[2]);
    expect(after.ch.split(',')[3]).toBe(before.ch.split(',')[3]);
    expect(after.tb.split(',')[3]).toBe(before.tb.split(',')[3]);
    expect(after.ch.split(',')[1]).toBe(before.ch.split(',')[1]);
    // No horizontal page scroll at either size.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
