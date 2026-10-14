import { expect, test, type Page } from '@playwright/test';
import { openChat, setTheme } from './helpers';

// Session parity UI stays legible in every theme: banners, notice, fallback note, strip editor.

const THEMES = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];

/** WCAG contrast of an element's text on its composited background, computed in the page. */
async function contrastOf(
  page: Page,
  selector: string,
  part: 'text' | 'border' = 'text',
): Promise<number> {
  return page.evaluate(
    ([sel, which]) => {
      type RGBA = [number, number, number, number];
      const parse = (c: string): RGBA => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        if (m) {
          const p = m[1]
            .split(/[ ,/]+/)
            .filter(Boolean)
            .map(Number);
          return [p[0], p[1], p[2], p[3] ?? 1];
        }
        const s = /color\(srgb ([^)]+)\)/.exec(c);
        if (s) {
          const p = s[1].split(/[ /]+/).filter(Boolean).map(Number);
          return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
        }
        return [0, 0, 0, 0];
      };
      const over = (t: RGBA, u: RGBA): RGBA => {
        const a = t[3] + u[3] * (1 - t[3]);
        if (a === 0) return [0, 0, 0, 0];
        const mix = (i: number) => (t[i] * t[3] + u[i] * u[3] * (1 - t[3])) / a;
        return [mix(0), mix(1), mix(2), a];
      };
      const lum = (c: RGBA) => {
        const f = (v: number) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no ${sel}`);
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      let bg: RGBA = [255, 255, 255, 1];
      for (const e of chain) bg = over(parse(getComputedStyle(e).backgroundColor), bg);
      const cs = getComputedStyle(el);
      const fg = over(parse(which === 'border' ? cs.borderTopColor : cs.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    },
    [selector, part] as const,
  );
}

for (const theme of THEMES) {
  for (const mode of ['light', 'dark'] as const) {
    test(`${theme} ${mode}: parity banners, notice and strip editor are legible`, async ({
      page,
    }) => {
      const id = await openChat(page, []);
      await setTheme(page, theme, mode);
      await page.evaluate((sid) => {
        const m = window.__PR_MOCK__!;
        m.setStatusline(sid, 'Opus 4.8 | patchroom-test', { model: 'Opus 4.8', mode: 'plan' });
        m.setTerminalDialog(sid, true, 'trust this folder');
      }, id);
      await expect(page.getByTestId('terminal-wait-banner')).toBeVisible();
      await page.getByTestId('composer-input').fill('x');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('composer-notice')).toBeVisible();
      for (const sel of [
        '.tbanner__text b',
        '.tbanner__text span',
        '.tbanner__btn',
        '.cnotice span',
        '.cnotice__btn',
      ]) {
        const c = await contrastOf(page, sel);
        expect(c, `${theme} ${mode}: ${sel} ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      // A key hint inside a button is text on the button's own fill: AA for glyphs and border.
      for (const part of ['text', 'border'] as const) {
        const c = await contrastOf(page, '.tbanner__btn kbd', part);
        expect(
          c,
          `${theme} ${mode}: .tbanner__btn kbd ${part} ${c.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      // The same DM as a mirror.
      await page.evaluate((sid) => {
        const m = window.__PR_MOCK__!;
        m.setTerminalDialog(sid, false);
        m.setMirror(sid, { where: 'iTerm', pid: 9, takeoverWhenClosed: false });
      }, id);
      await expect(page.getByTestId('mirror-banner')).toBeVisible();
      for (const sel of [
        '.mbanner__text b',
        '.mbanner__text span',
        '.mbanner__btn',
        '.mbanner__btn--quiet',
      ]) {
        const c = await contrastOf(page, sel);
        expect(c, `${theme} ${mode}: ${sel} ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      await page.evaluate((sid) => window.__PR_MOCK__!.setMirror(sid, null), id);
      // A running turn shows Stop with its key hint.
      await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'busy'), id);
      await expect(page.getByTestId('stop')).toBeVisible();
      for (const part of ['text', 'border'] as const) {
        const c = await contrastOf(page, '.stop kbd', part);
        expect(c, `${theme} ${mode}: .stop kbd ${part} ${c.toFixed(2)}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      // The editor.
      await page.getByTestId('strip-customize').click();
      for (const sel of ['.sbe__name', '.sbe__tag', '.sbe__add', '.sbmenu__note', '.sbe__h']) {
        const c = await contrastOf(page, sel);
        expect(c, `${theme} ${mode}: ${sel} ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      await page.keyboard.press('Escape');
      // The fallback note over the terminal.
      await page.evaluate((sid) => window.__PR_STORE__!.openFallback(sid, 'Answer it here.'), id);
      await expect(page.getByTestId('term-note')).toBeVisible();
      for (const sel of ['.tnote span', '.tnote button']) {
        const c = await contrastOf(page, sel);
        expect(c, `${theme} ${mode}: ${sel} ${c.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}
