import { expect, test, type Page } from '@playwright/test';
import { openWithDm } from './helpers';

/**
 * The Patch Bay cable must never cover text or anything clickable. It runs in a channel at the
 * sidebar's inner right edge, so this walks the real cable path and checks every sample against
 * every text node and interactive element, in both views, at both window sizes, for every
 * theme in light and dark and every cable preset.
 */
const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];
const WIDTHS = [220, 264, 420];
const PRESETS = ['theme', 'jade', 'signal', 'studio', 'ocean', 'copper'];
const SIZES = [
  { width: 880, height: 520 },
  { width: 1400, height: 900 },
];
const APP = 'mock&persist&grid=100x30';

interface Hit {
  kind: string;
  what: string;
  at: string;
}

/** Walks the cable path in the page and returns every sample that touches content. */
async function crossings(page: Page): Promise<{ hits: Hit[]; samples: number }> {
  return page.evaluate(() => {
    const root = document.querySelector('.pr-app') as HTMLElement;
    const svg = root.querySelector(':scope > svg.cable') as SVGSVGElement;
    const path = svg.querySelectorAll('path')[1] as SVGPathElement;
    const rr = root.getBoundingClientRect();
    const k = rr.width / root.offsetWidth || 1;
    const len = path.getTotalLength();
    // Cable rubber is 5 wide, its shadow 7 wide and 3 lower: half of 7 around the sample, plus the shadow offset.
    const R = 3.5;
    const pts: { x: number; y: number }[] = [];
    for (let l = 0; l <= len; l += 2) {
      const p = path.getPointAtLength(l);
      const x = rr.left + p.x * k;
      const y = rr.top + p.y * k;
      pts.push({ x, y }, { x, y: y + 3 * k });
    }
    const hits: Hit[] = [];
    const touches = (r: { left: number; right: number; top: number; bottom: number }) =>
      pts.some(
        (p) => p.x + R > r.left && p.x - R < r.right && p.y + R > r.top && p.y - R < r.bottom,
      );
    const shown = (el: Element | null) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      }
      return true;
    };
    const inView = (r: DOMRect) =>
      r.width > 0 &&
      r.height > 0 &&
      r.right > 0 &&
      r.bottom > 0 &&
      r.left < innerWidth &&
      r.top < innerHeight;
    const label = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}`;

    // Text nodes.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? '';
      const parent = n.parentElement;
      if (!t.trim() || !parent || parent.closest('svg, .sr-only') || !shown(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) {
        if (inView(r) && touches(r))
          hits.push({
            kind: 'text',
            what: `"${t.trim().slice(0, 30)}" in ${label(parent)}`,
            at: `${Math.round(r.left)},${Math.round(r.top)}`,
          });
      }
    }
    // Interactive elements. The active row hosts the cable's own plug, so it is the one element
    // allowed under the cable's first few pixels (its text is still checked above).
    const interactive =
      'a[href],button,input,select,textarea,summary,[role=button],[role=menuitem],[role=tab],[tabindex]:not([tabindex="-1"]),[contenteditable=true]';
    for (const el of Array.from(root.querySelectorAll(interactive))) {
      if (el.closest('svg') || !shown(el)) continue;
      if (el.matches('.row.active')) continue;
      const r = el.getBoundingClientRect();
      if (inView(r) && touches(r))
        hits.push({
          kind: 'interactive',
          what: label(el),
          at: `${Math.round(r.left)},${Math.round(r.top)}`,
        });
    }
    // The terminal draws its text on a canvas, so its whole screen counts as content.
    for (const el of Array.from(root.querySelectorAll('.xterm-screen, .xterm-rows'))) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (inView(r) && touches(r))
        hits.push({
          kind: 'terminal',
          what: label(el),
          at: `${Math.round(r.left)},${Math.round(r.top)}`,
        });
    }
    return { hits, samples: pts.length / 2 };
  });
}

async function setLook(
  page: Page,
  themeId: string,
  mode: string,
  cablePreset: string,
  sidebarWidth = 264,
) {
  await page.evaluate((p) => window.__PR_STORE__!.setPrefs({ base: 'patchbay', ...p } as never), {
    themeId,
    mode,
    cablePreset,
    sidebarWidth,
  });
  const app = page.locator('.pr-app');
  await expect(app).toHaveAttribute('data-base', 'patchbay');
  await expect(app).toHaveAttribute('data-theme', themeId);
  await expect(app).toHaveAttribute('data-mode', mode);
  await expect(page.locator('.pr-app > svg.cable')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.side')!.getBoundingClientRect().width))
    .toBe(sidebarWidth);
  // Let the cable re-measure after fonts and layout settle.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

for (const size of SIZES) {
  for (const themeId of THEMES) {
    for (const mode of ['light', 'dark']) {
      test(`cable crosses no content: ${themeId} ${mode} ${size.width}x${size.height}`, async ({
        page,
      }) => {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme: mode as 'light' | 'dark' });
        await openWithDm(page, APP, 'chat');
        for (const view of ['chat', 'terminal'] as const) {
          if (view === 'terminal') {
            await page.keyboard.press('Meta+j');
            await page.locator('[data-testid="terminal"]').first().waitFor({ state: 'visible' });
          }
          for (const width of WIDTHS) {
            for (const preset of PRESETS) {
              await setLook(page, themeId, mode, preset, width);
              const { hits, samples } = await crossings(page);
              expect(samples, `${view}/${preset}/${width}: cable has a path`).toBeGreaterThan(20);
              expect(hits, `${view}/${preset}/${width}`).toEqual([]);
            }
          }
        }
      });
    }
  }
}

test('the status strip band spans the whole pane in Patch Bay', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openWithDm(page, APP, 'chat');
  await setLook(page, 'homeroom', 'light', 'theme');
  const m = await page.evaluate(() => {
    const strip = document.querySelector('.strip')!.getBoundingClientRect();
    const conv = document.querySelector('.conv')!.getBoundingClientRect();
    return { sl: strip.left, sr: strip.right, cl: conv.left, cr: conv.right };
  });
  expect(m.sl).toBeCloseTo(m.cl, 0);
  expect(m.sr).toBeCloseTo(m.cr, 0);
});
