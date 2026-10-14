import { expect, test, type Page } from '@playwright/test';
import { openWithDm } from './helpers';

// 880 is the window minimum (src-tauri/tauri.conf.json).
const WIDTHS = [1400, 1250, 1100, 1000, 950, 900, 880];
const SCHEMES = ['light', 'dark'] as const;

/** Elements whose text is cut off by overflow without an ellipsis to say so. */
async function silentClips(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const bad: string[] = [];
    document.querySelectorAll<HTMLElement>(`${sel} *`).forEach((el) => {
      if (!el.textContent?.trim() || el.children.length > 0) return;
      if (el.closest('.sr-only')) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'visible') return;
      if (cs.textOverflow !== 'ellipsis' || cs.display === 'inline')
        bad.push(el.className || el.tagName);
    });
    return bad;
  }, scope);
}

test.describe('layout', () => {
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      test(`header and sidebar never clip silently, ${scheme} ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        const id = await openWithDm(page, 'mock');
        await page.evaluate((sid) => {
          window.__PR_MOCK__!.setTitle(
            sid,
            'A very long conversation title that cannot possibly fit in the header row',
          );
        }, id);
        await expect(page.locator('.ch__status')).toBeVisible();
        await expect(page.getByTestId('term-title')).toBeVisible();
        expect(await silentClips(page, '.ch')).toEqual([]);
        expect(await silentClips(page, '.side')).toEqual([]);
        // The folder name stays visible and the row never spills past the header.
        const base = await page.locator('.ch__cwd-base').boundingBox();
        const head = await page.locator('.ch').boundingBox();
        expect(base!.x + base!.width).toBeLessThanOrEqual(head!.x + head!.width);
        // The cwd reads as one string: no gap between the parent path and the folder name.
        const cwdText = await page.locator('.ch__cwd-path').evaluate((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return { text: el.textContent, rects: r.getClientRects().length };
        });
        expect(cwdText.text).toBe('/tmp/patchroom-test');
        const dir = (await page.locator('.ch__cwd-dir').boundingBox())!;
        const bs = (await page.locator('.ch__cwd-base').boundingBox())!;
        expect(Math.abs(bs.x - (dir.x + dir.width))).toBeLessThanOrEqual(0.5);
        // Form controls: the selected label either fits or truncates with an ellipsis.
        const selectClip = await page.locator('.ch .tools select').evaluate((el) => {
          const s = el as HTMLSelectElement;
          const cs = getComputedStyle(s);
          const c = document.createElement('canvas').getContext('2d')!;
          c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const need = c.measureText(s.selectedOptions[0].text).width;
          const room =
            s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
          return { fits: need <= room, ellipsis: cs.textOverflow === 'ellipsis' };
        });
        expect(selectClip.fits || selectClip.ellipsis).toBe(true);
        for (const b of await page.locator('.ch .tools button').all()) {
          expect(await b.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        }
        const meta = await page
          .locator('.ch .meta')
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
        expect(meta).toBe(true);
      });
    }
  }

  test('exit state is app chrome, not terminal text', async ({ page }) => {
    const id = await openWithDm(page, 'mock');
    await page.evaluate((sid) => window.__PR_MOCK__!.exit(sid, 1), id);
    await expect(page.getByTestId('exit-bar')).toContainText('Process exited with code 1');
    const buf = await page.evaluate((sid) => {
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
      let out = '';
      for (let i = 0; i < b.length; i++) out += b.getLine(i)?.translateToString() ?? '';
      return out;
    }, id);
    expect(buf).not.toContain('process exited');
  });

  test('long DM name in a long section never pushes the header past the window', async ({
    page,
  }) => {
    for (const scheme of SCHEMES) {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/?mock');
        await page.getByRole('button', { name: 'New section' }).click();
        await page
          .getByPlaceholder('Section name')
          .fill('Client engagements and other extremely long section names 2026');
        await page.getByPlaceholder('Section name').press('Enter');
        await page.getByRole('button', { name: 'New DM' }).first().click();
        const dlg = page.getByRole('dialog', { name: 'New DM' });
        await dlg
          .getByLabel('Folder')
          .fill('/Users/someone/projects/deeply/nested/folder/with-a-long-repository-name');
        await dlg
          .getByLabel('Name (optional)')
          .fill('refactor-the-entire-billing-pipeline-for-the-quarterly-close');
        await dlg.getByRole('button', { name: 'Start DM' }).click();
        await page.locator('.ch .tools select').selectOption({
          label: 'Client engagements and other extremely long section names 2026',
        });
        const id = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0].id);
        await page.evaluate((sid) => {
          window.__PR_MOCK__!.setStatus(sid, 'waiting', 'permission');
          window.__PR_MOCK__!.setTitle(sid, 'Refactor billing pipeline and reconcile ledgers');
        }, id);
        const at = `${scheme} ${width}px`;
        const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;

        // Nothing spills past the header, and the header itself does not scroll.
        const head = await box('.ch');
        const end = await box('.ch .tools button[aria-label="End session"]');
        expect(end.x + end.width, `End session inside header, ${at}`).toBeLessThanOrEqual(
          head.x + head.width,
        );
        expect(
          await page.locator('.ch').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);

        // Status: whole, uncut, inside .meta; .meta does not overflow.
        await expect(page.locator('.ch__status')).toHaveText('Needs you: permission');
        const meta = await box('.ch .meta');
        const status = await box('.ch__status');
        expect(status.x + status.width, `status inside meta, ${at}`).toBeLessThanOrEqual(
          meta.x + meta.width + 0.5,
        );
        for (const sel of ['.ch__status', '.ch .meta']) {
          expect(
            await page.locator(sel).evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
            `${sel} does not overflow, ${at}`,
          ).toBe(true);
        }

        // The name and the folder name keep a readable floor and truncate with an ellipsis.
        for (const sel of ['.ch__name', '.ch__cwd-base']) {
          const w = await page.locator(sel).evaluate((el) => el.getBoundingClientRect().width);
          expect(w, `${sel} visible width, ${at}`).toBeGreaterThanOrEqual(18);
        }
        const name = await box('.ch__name');
        const h2 = await box('.ch h2');
        expect(name.x + name.width).toBeLessThanOrEqual(h2.x + h2.width + 0.5);
        const base = await box('.ch__cwd-base');
        const cwd = await box('.ch__cwd');
        expect(base.x + base.width, `folder name inside cwd, ${at}`).toBeLessThanOrEqual(
          cwd.x + cwd.width + 0.5,
        );

        // A cut parent path still shows its ellipsis: never a zero-width box.
        const dirW = await page
          .locator('.ch__cwd-dir')
          .evaluate((el) => el.getBoundingClientRect().width);
        expect(dirW, `parent path width, ${at}`).toBeGreaterThanOrEqual(8);

        // Header groups never overlap each other.
        const groups = ['.ch h2', '.ch .fid', '.ch .meta', '.ch .tools'];
        const rects: { sel: string; x: number; r: number }[] = [];
        for (const sel of groups) {
          if (!(await page.locator(sel).first().isVisible())) continue;
          const b = await box(sel);
          rects.push({ sel, x: b.x, r: b.x + b.width });
        }
        for (let i = 1; i < rects.length; i++) {
          expect(
            rects[i].x,
            `${rects[i].sel} starts after ${rects[i - 1].sel}, ${at}`,
          ).toBeGreaterThanOrEqual(rects[i - 1].r - 0.5);
        }
        // The h2 glyph stays inside the h2.
        const glyph = await page.locator('.ch h2 svg').first().boundingBox();
        if (glyph) expect(glyph.x + glyph.width).toBeLessThanOrEqual(h2.x + h2.width + 0.5);

        // The section select never runs under the End session button.
        const sel = await box('.ch .tools select');
        expect(sel.x + sel.width, `select clear of End session, ${at}`).toBeLessThanOrEqual(
          end.x + 0.5,
        );
        expect(await silentClips(page, '.ch')).toEqual([]);
      }
    }
  });

  test('header boxes only grow as the window widens', async ({ page }) => {
    await page.setViewportSize({ width: 880, height: 800 });
    await page.goto('/?mock');
    await page.getByRole('button', { name: 'New DM' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'New DM' });
    await dlg
      .getByLabel('Folder')
      .fill('/Users/someone/projects/deeply/nested/folder/with-a-long-repository-name');
    await dlg
      .getByLabel('Name (optional)')
      .fill('refactor-the-entire-billing-pipeline-for-the-quarterly-close');
    await dlg.getByRole('button', { name: 'Start DM' }).click();
    const id = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0].id);
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'waiting', 'permission'), id);
    const widths = (sel: string) =>
      page.locator(sel).evaluate((el) => el.getBoundingClientRect().width);
    const parts = ['.ch__name', '.ch__cwd-base', '.ch__cwd-dir', '.ch .meta'];
    let prev: number[] | null = null;
    for (let w = 880; w <= 1400; w += 20) {
      await page.setViewportSize({ width: w, height: 800 });
      const now = await Promise.all(parts.map(widths));
      if (prev) {
        parts.forEach((p, i) =>
          expect(now[i], `${p} at ${w}px vs ${w - 20}px`).toBeGreaterThanOrEqual(prev![i] - 0.5),
        );
      }
      prev = now;
    }
  });

  test('long cwd keeps the folder name and offers a tooltip', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto('/?mock');
    await page.getByRole('button', { name: 'New DM' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'New DM' });
    await dlg.getByLabel('Folder').fill('/Users/NDP/code/some/deeply/nested/projects/patchroom');
    await dlg.getByRole('button', { name: 'Start DM' }).click();
    await expect(page.locator('.ch__cwd-base')).toHaveText('patchroom');
    await expect(page.locator('.ch__cwd')).toHaveAttribute('title', /deeply\/nested/);
    expect(await page.locator('.ch__cwd-dir').textContent()).toMatch(/^~\//);
  });

  test('New DM dialog aligns the folder input and Browse button', async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?mock');
      await page.getByRole('button', { name: 'New DM' }).first().click();
      const dlg = page.getByRole('dialog', { name: 'New DM' });
      const input = (await dlg.getByLabel('Folder').boundingBox())!;
      const btn = (await dlg.getByRole('button', { name: 'Browse' }).boundingBox())!;
      expect(Math.abs(input.y - btn.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(input.height - btn.height)).toBeLessThanOrEqual(1);
      const box = (await dlg.boundingBox())!;
      expect(btn.x + btn.width).toBeLessThanOrEqual(box.x + box.width);
      expect(box.x).toBeGreaterThanOrEqual(0);
    }
  });
});
