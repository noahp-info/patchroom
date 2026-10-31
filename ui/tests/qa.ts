import { expect, type Page } from '@playwright/test';

/*
 * Layout QA shared by every surface test (CLAUDE.md, "UI work: overlap rule").
 *
 * - `expectNoOverlap(page)`: visible text and controls never draw over each other, text never
 *   clips without an ellipsis, and nothing scrolls the page sideways.
 * - `ringFindings(page, scope)`: the ring rule. An outline, ring, border or highlight box keeps
 *   `--ring-pad` between itself and its content, and outlined siblings sit `--ring-gap` apart.
 *
 * Both run in the page and return readable findings, so a failure names what touched what.
 */

/** Layers that may cover base content on purpose: menus, pickers, dialogs, popovers. */
export const LAYERS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.floating',
  '.prefs',
  '.qs',
  '.shot',
  '.hint',
].join(', ');

export interface OverlapOptions {
  /** Only check ink inside this selector. Default: the whole app. */
  scope?: string;
  /** Extra selectors whose ink is skipped (intentional layering). */
  ignore?: string[];
}

/** Every finding of the overlap rule on the current screen. */
export async function overlapFindings(page: Page, opts: OverlapOptions = {}): Promise<string[]> {
  return page.evaluate(
    ({ scope, ignore, layers }) => {
      const out: string[] = [];
      const root = document.querySelector(scope) ?? document.body;
      const skip = ignore.length ? ignore.join(', ') : null;
      const CTL = 'button, input, select, textarea, [role="button"], [role="switch"], a[href]';

      // The visible part of a box: clipped by every ancestor that clips overflow. A text box
      // is also clipped by its own element (an ellipsized label's text runs past its box).
      const clipOf = (el: Element, r: DOMRect, self = false) => {
        let { left, top, right, bottom } = r;
        for (let p = self ? el : el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.contain === 'paint') {
            const pr = p.getBoundingClientRect();
            left = Math.max(left, pr.left);
            top = Math.max(top, pr.top);
            right = Math.min(right, pr.right);
            bottom = Math.min(bottom, pr.bottom);
          }
          if (cs.position === 'fixed') break;
        }
        return right - left > 0.5 && bottom - top > 0.5 ? { left, top, right, bottom } : null;
      };
      const hidden = (el: Element) => {
        for (let e: Element | null = el; e; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0)
            return true;
          if (e.classList.contains('sr-only') || cs.clipPath === 'inset(50%)') return true;
          if (e.hasAttribute('inert')) return false;
        }
        return false;
      };
      const layerOf = (el: Element) => el.closest(layers) ?? null;
      // Stacked chrome: a log scrolls under sticky bars by design, so sticky content is its own layer.
      const stickyOf = (el: Element) => {
        for (let e: Element | null = el; e; e = e.parentElement) {
          const p = getComputedStyle(e).position;
          if (p === 'sticky' || p === 'fixed') return e;
        }
        return null;
      };

      interface Ink {
        el: Element;
        kind: 'text' | 'ctl';
        box: { left: number; top: number; right: number; bottom: number };
        layer: Element | null;
        sticky: Element | null;
        label: string;
      }
      const ink: Ink[] = [];
      const name = (el: Element) => {
        const t = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
        const c = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
        return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}"${t}"`;
      };

      // Controls.
      for (const el of root.querySelectorAll(CTL)) {
        if (skip && el.closest(skip)) continue;
        if (hidden(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const box = clipOf(el, r);
        if (!box) continue;
        ink.push({
          el,
          kind: 'ctl',
          box,
          layer: layerOf(el),
          sticky: stickyOf(el),
          label: name(el),
        });
      }
      // Text, one box per line of each text node.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const el = n.parentElement;
        if (!el || hidden(el)) continue;
        if (skip && el.closest(skip)) continue;
        if (el.closest('.xterm, option, script, style, svg, .viewer__wait')) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          const box = clipOf(el, r, true);
          if (!box) continue;
          ink.push({
            el,
            kind: 'text',
            box,
            layer: layerOf(el),
            sticky: stickyOf(el),
            label: `"${(n.textContent ?? '').trim().slice(0, 30)}"`,
          });
        }
      }

      // Pairs. 2px of slack absorbs line-height overhang and focus rings.
      const SLACK = 2;
      for (let i = 0; i < ink.length; i++) {
        const a = ink[i];
        for (let j = i + 1; j < ink.length; j++) {
          const b = ink[j];
          if (a.layer !== b.layer || a.sticky !== b.sticky) continue;
          if (a.el === b.el) continue;
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          // A field's own drawn text (a placeholder laid over it in the same wrapper).
          const field = (x: Ink) => x.el.matches('input, textarea, select');
          if ((field(a) || field(b)) && a.el.parentElement === b.el.parentElement) continue;
          const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
          const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
          if (w > SLACK && h > SLACK) out.push(`overlap: ${a.label} x ${b.label}`);
        }
      }

      // Text cut off without an ellipsis.
      for (const el of root.querySelectorAll<HTMLElement>('*')) {
        if (el.children.length > 0 || !el.textContent?.trim()) continue;
        if (skip && el.closest(skip)) continue;
        if (el.closest('.xterm, .sr-only, textarea, pre, code, .log, .ced__tokens')) continue;
        if (hidden(el)) continue;
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        const cs = getComputedStyle(el);
        if (cs.overflowX === 'visible' || cs.display === 'inline') continue;
        if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
        if (cs.textOverflow !== 'ellipsis') out.push(`clipped without ellipsis: ${name(el)}`);
      }

      // Sideways scroll.
      const doc = document.scrollingElement ?? document.documentElement;
      if (doc.scrollWidth > window.innerWidth + 1)
        out.push(
          `horizontal overflow: page is ${doc.scrollWidth}px in a ${window.innerWidth}px window`,
        );
      const app = document.querySelector('.pr-app');
      if (app && app.scrollWidth > app.clientWidth + 1)
        out.push(`horizontal overflow: app is ${app.scrollWidth}px in ${app.clientWidth}px`);
      return [...new Set(out)];
    },
    { scope: opts.scope ?? '.pr-app', ignore: opts.ignore ?? [], layers: LAYERS },
  );
}

/** Fail with every overlap finding listed. */
export async function expectNoOverlap(page: Page, opts: OverlapOptions = {}): Promise<void> {
  expect(await overlapFindings(page, opts)).toEqual([]);
}

/**
 * Ring rule findings inside `scope`. A framed box is a non-control element with a border on
 * all four sides, an inset ring, or an outline. Its content (text, controls, images and nested
 * framed boxes) keeps `--ring-pad` from the frame's inner edge; framed siblings keep
 * `--ring-gap` between them. Single-line controls (buttons, fields, chips) are exempt: their
 * size comes from the control height.
 */
export async function ringFindings(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const app = document.querySelector('.pr-app') ?? document.documentElement;
    const css = getComputedStyle(app);
    const pad = parseFloat(css.getPropertyValue('--ring-pad'));
    const gap = parseFloat(css.getPropertyValue('--ring-gap'));
    if (!(pad > 0 && gap > 0)) return ['--ring-pad and --ring-gap are not defined'];
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(e);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const CTL = 'button, input, select, textarea, summary, label, kbd, code';
    const framed = (e: Element) => {
      if (!shown(e)) return false;
      const r = e.getBoundingClientRect();
      if (e.matches(CTL) && r.height <= 40) return false;
      // Segmented controls and chip rails are one control: their own height sets the room.
      if (e.matches('[role="radiogroup"], [role="group"], .pf-seg, .viewseg') && r.height <= 40)
        return false;
      if (e.closest('svg, .tp, .tprev, .termprev, .tmp__swatches')) return false;
      const cs = getComputedStyle(e);
      const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
      const border = sides.every(
        (s) =>
          parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0 &&
          cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== 'none' &&
          !/rgba\(0, 0, 0, 0\)|transparent/.test(
            cs.getPropertyValue(`border-${s.toLowerCase()}-color`),
          ),
      );
      // An inset ring: no offset, a spread (computed as "<color> 0px 0px 0px 2px inset").
      const ring = cs.boxShadow
        .split(/,(?![^(]*\))/)
        .some((sh) => /inset/.test(sh) && /\b0px 0px \d+(\.\d+)?px [1-9]/.test(sh));
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      return border || ring || outline;
    };
    const name = (el: Element) => {
      const c = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      const t = (el.textContent ?? '').trim().slice(0, 30);
      return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}"${t}"`;
    };
    const root = document.querySelector(sel);
    if (!root) return out;
    const boxes = [...root.querySelectorAll('*')].filter(framed);
    for (const box of boxes) {
      const r = box.getBoundingClientRect();
      const cs = getComputedStyle(box);
      // Scrolling frames clip their content by design; their rows carry the padding.
      if (/(auto|scroll)/.test(cs.overflowY) && box.scrollHeight > box.clientHeight + 1) continue;
      const bw = (s: string) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) || 0;
      const inner = {
        left: r.left + bw('left'),
        top: r.top + bw('top'),
        right: r.right - bw('right'),
        bottom: r.bottom - bw('bottom'),
      };
      // Content: text lines and leaf ink, not descending into nested frames.
      const rects: DOMRect[] = [];
      const walk = (el: Element) => {
        for (const c of el.childNodes) {
          if (c.nodeType === Node.TEXT_NODE) {
            if (!c.textContent?.trim()) continue;
            const rg = document.createRange();
            rg.selectNodeContents(c);
            rects.push(...rg.getClientRects());
          } else if (c instanceof Element) {
            if (!shown(c)) continue;
            if (framed(c) || c.matches('button, input, select, textarea, img, svg, canvas'))
              rects.push(c.getBoundingClientRect());
            else walk(c);
          }
        }
      };
      walk(box);
      if (rects.length === 0) continue;
      const d = {
        left: Math.min(...rects.map((x) => x.left)) - inner.left,
        top: Math.min(...rects.map((x) => x.top)) - inner.top,
        right: inner.right - Math.max(...rects.map((x) => x.right)),
        bottom: inner.bottom - Math.max(...rects.map((x) => x.bottom)),
      };
      // Text boxes carry half-leading above and below the glyphs: count 2px of it as room.
      const tight = Object.entries(d)
        .filter(([side, v]) => v < pad - (side === 'top' || side === 'bottom' ? 2.5 : 0.5))
        .map(([side, v]) => `${side} ${v.toFixed(1)}px`);
      if (tight.length) out.push(`padding ${tight.join(', ')}: ${name(box)}`);
    }
    // Framed siblings.
    for (const box of boxes) {
      const p = box.parentElement;
      if (!p) continue;
      for (const sib of p.children) {
        if (sib === box || !boxes.includes(sib)) continue;
        if (box.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_PRECEDING) continue;
        const a = box.getBoundingClientRect();
        const b = sib.getBoundingClientRect();
        const dx = Math.max(b.left - a.right, a.left - b.right);
        const dy = Math.max(b.top - a.bottom, a.top - b.bottom);
        const dist = Math.max(dx, dy);
        if (dist < gap - 0.5)
          out.push(`siblings ${dist.toFixed(1)}px apart: ${name(box)} / ${name(sib)}`);
      }
    }
    return [...new Set(out)];
  }, scope);
}
