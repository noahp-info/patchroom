/** Minimal SGR parser for the status strip: the user's statusLine output, rendered as written. */

import { ensureContrast } from '../theme/color.ts';

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

/** The iTerm2 default palette, the same one the terminal uses. */
const BASE16 = [
  '#000000',
  '#c91b00',
  '#00c200',
  '#c7c400',
  '#0225c7',
  '#c930c7',
  '#00c5c7',
  '#c7c7c7',
  '#676767',
  '#ff6d67',
  '#5ff967',
  '#fefb67',
  '#6871ff',
  '#ff76ff',
  '#5ffdff',
  '#ffffff',
];

function color256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 16) return BASE16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return hex(v, v, v);
  }
  const i = n - 16;
  const lv = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return hex(lv(Math.floor(i / 36)), lv(Math.floor(i / 6) % 6), lv(i % 6));
}

function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  let s = { ...style };
  const list = params.length === 0 ? [0] : params;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p === 0) s = {};
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) {
      s.bold = false;
      s.dim = false;
    } else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p >= 30 && p <= 37) s.fg = BASE16[p - 30];
    else if (p === 39) s.fg = undefined;
    else if (p >= 40 && p <= 47) s.bg = BASE16[p - 40];
    else if (p === 49) s.bg = undefined;
    else if (p >= 90 && p <= 97) s.fg = BASE16[p - 90 + 8];
    else if (p >= 100 && p <= 107) s.bg = BASE16[p - 100 + 8];
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' : 'bg';
      if (list[i + 1] === 5) {
        s[target] = color256(list[i + 2]);
        i += 2;
      } else if (list[i + 1] === 2) {
        const [r, g, b] = [list[i + 2], list[i + 3], list[i + 4]];
        s[target] = hex(r & 255, g & 255, b & 255);
        i += 4;
      }
    }
  }
  return s;
}

/**
 * Split ANSI text into lines of styled spans. SGR is applied; every other escape sequence
 * (cursor moves, OSC titles and hyperlinks) is dropped so it never prints as junk.
 */
export function parseAnsi(input: string): AnsiSpan[][] {
  const lines: AnsiSpan[][] = [[]];
  let style: AnsiStyle = {};
  let buf = '';
  const flush = () => {
    if (buf) lines[lines.length - 1].push({ text: buf, style });
    buf = '';
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\x1b') {
      const next = input[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < input.length && !/[\x40-\x7e]/.test(input[j])) j++;
        const final = input[j];
        if (final === 'm') {
          flush();
          const body = input.slice(i + 2, j);
          style = applySgr(
            style,
            body === '' ? [] : body.split(/[;:]/).map((x) => Number.parseInt(x, 10) || 0),
          );
        }
        i = j;
        continue;
      }
      if (next === ']') {
        let j = i + 2;
        while (
          j < input.length &&
          input[j] !== '\x07' &&
          !(input[j] === '\x1b' && input[j + 1] === '\\')
        )
          j++;
        i = input[j] === '\x1b' ? j + 1 : j;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '\n') {
      flush();
      lines.push([]);
      continue;
    }
    if (ch === '\r') continue;
    buf += ch;
  }
  flush();
  while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

/** CSS for a span's style. Inverse swaps the colors, using the terminal defaults. */
/**
 * Inline CSS for one span. With `ground` (the hex color the text sits on), a foreground with no
 * background of its own is nudged until it reads at 4.5:1: terminal palettes are tuned for dark
 * grounds, and the strip sits on the theme's own ground.
 */
export function ansiCss(style: AnsiStyle, ground?: string): Record<string, string> {
  const css: Record<string, string> = {};
  let fg = style.fg;
  let bg = style.bg;
  if (ground && fg && !bg && !style.inverse && fg.startsWith('#')) {
    fg = ensureContrast(fg, ground);
  }
  if (style.inverse) {
    const f = fg ?? 'var(--fg)';
    fg = bg ?? 'var(--bg)';
    bg = f;
  }
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (style.bold) css.fontWeight = '700';
  if (style.dim) css.opacity = '0.7';
  if (style.italic) css.fontStyle = 'italic';
  if (style.underline) css.textDecoration = 'underline';
  return css;
}
