import { contrast, ensureContrast, mix, readableOn } from './color.ts';
import { repairContrast } from './repair.ts';
import type { Theme, ThemeMode, TokenMap } from './types.ts';

/**
 * Slack's theme string is up to ten comma-separated hex colors, in this order:
 * column_bg, menu_bg_hover, active_item, active_item_text, hover_item,
 * text_color, active_presence, mention_badge, top_nav_bg, top_nav_text.
 * The first four are required. Older strings stop at eight or nine.
 */
export const SLACK_FIELDS = [
  'columnBg',
  'menuBgHover',
  'activeItem',
  'activeItemText',
  'hoverItem',
  'textColor',
  'activePresence',
  'mentionBadge',
  'topNavBg',
  'topNavText',
] as const;

export type SlackField = (typeof SLACK_FIELDS)[number];
export type SlackColors = Partial<Record<SlackField, string>> &
  Record<'columnBg' | 'menuBgHover' | 'activeItem' | 'activeItemText', string>;

export type SlackParse = { ok: true; colors: SlackColors } | { ok: false; error: string };

/** Parse a pasted Slack theme string. Tolerates quotes, brackets, a JSON wrapper and spaces. */
export function parseSlackThemeString(input: string): SlackParse {
  const parts = input
    // Drop a leading JSON key such as `{"theme":`.
    .trim()
    .replace(/^\{?\s*["']?[A-Za-z_]\w*["']?\s*:\s*/, '')
    .replace(/["'`[\]{}]/g, ' ')
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (parts.length < 4 || parts.length > 10) {
    return { ok: false, error: `Expected 4 to 10 hex colors, found ${parts.length}.` };
  }
  const colors: Partial<Record<SlackField, string>> = {};
  for (const [i, p] of parts.entries()) {
    const m = /^#?([0-9a-f]{6})$/i.exec(p);
    if (!m) return { ok: false, error: `Color ${i + 1} ("${p}") is not a 6-digit hex color.` };
    colors[SLACK_FIELDS[i]] = `#${m[1].toLowerCase()}`;
  }
  return { ok: true, colors: colors as SlackColors };
}

export interface SlackImportOptions {
  /** A complete theme that supplies every token Slack's string does not carry. */
  base: Theme;
  id: string;
  name: string;
}

/** A solid fill that white or black text can sit on at 4.5:1, darkened if the input is mid-tone. */
function solid(color: string): { fill: string; ink: string } {
  let fill = color;
  for (
    let t = 0;
    t <= 1 && Math.max(contrast('#fff', fill), contrast('#000', fill)) < 4.5;
    t += 0.05
  ) {
    fill = mix(color, '#000000', t);
  }
  return { fill, ink: readableOn(fill) };
}

function mapMode(c: SlackColors, base: TokenMap, mode: ThemeMode): TokenMap {
  const t: TokenMap = { ...base };
  const sideBg = c.columnBg;
  const sideFg = ensureContrast(c.textColor ?? readableOn(sideBg), sideBg);
  const sideActive = c.activeItem;
  const sideActiveFg = ensureContrast(c.activeItemText, sideActive);
  const tbBg = c.topNavBg ?? sideBg;
  const tbFg = ensureContrast(c.topNavText ?? readableOn(tbBg), tbBg);
  const tbField = mix(tbBg, tbFg, 0.12);

  t['side-bg'] = sideBg;
  t['side-fg'] = sideFg;
  t['side-muted'] = ensureContrast(mix(sideFg, sideBg, 0.3), sideBg);
  t['side-strong'] = readableOn(sideBg);
  t['side-line'] = mix(sideBg, sideFg, 0.12);
  t['side-hover'] = c.hoverItem ?? c.menuBgHover;
  t['side-active'] = sideActive;
  t['side-active-fg'] = sideActiveFg;
  t['ws-mark'] = sideActive;
  t['ws-mark-fg'] = sideActiveFg;

  t['tb-bg'] = tbBg;
  t['tb-fg'] = tbFg;
  t['tb-field'] = tbField;
  t['tb-muted'] = ensureContrast(mix(tbFg, tbBg, 0.25), tbField);
  t['tb-line'] = mix(tbBg, tbFg, 0.15);

  const acc = solid(c.activeItem);
  t.accent = acc.fill;
  t['accent-hover'] = mix(acc.fill, acc.ink === '#ffffff' ? '#000000' : '#ffffff', 0.12);
  t['accent-fg'] = acc.ink;
  t['accent-text'] = ensureContrast(acc.fill, t.bg);
  t.link = ensureContrast(c.activeItem, t.bg);

  if (c.mentionBadge) {
    const n = solid(c.mentionBadge);
    t.needs = n.fill;
    t['needs-fg'] = n.ink;
    t['c-red'] = n.fill;
  }
  if (c.activePresence) {
    t.busy = c.activePresence;
    t['c-green'] = c.activePresence;
  }

  // Patch Bay reads the sidebar colors as its panel.
  t.panel = sideBg;
  t['panel-2'] = tbBg;
  t['panel-edge'] = t['side-line'];
  t.silk = sideFg;
  t['silk-muted'] = t['side-muted'];
  t.nut = mix(sideFg, sideBg, 0.55);
  // The cable follows the active row; the plug is the sidebar ink pushed toward silver.
  t.cable = sideActive;
  t.plug = mix(sideFg, '#ffffff', 0.3);
  t.hole = mode === 'dark' ? '#050505' : '#1c1b19';
  return t;
}

export type SlackImport = { ok: true; theme: Theme } | { ok: false; error: string };

/**
 * Turn a Slack theme string into a full light and dark theme. Slack colors drive the sidebar,
 * title bar, active row, presence and badge. The base theme fills the rest, and failing text
 * pairs are repaired to WCAG AA.
 */
export function importSlackTheme(input: string, opts: SlackImportOptions): SlackImport {
  const parsed = parseSlackThemeString(input);
  if (!parsed.ok) return parsed;
  const theme: Theme = {
    schemaVersion: 1,
    id: opts.id,
    name: opts.name,
    description: 'Imported from a Slack theme string.',
    modes: {
      light: mapMode(parsed.colors, opts.base.modes.light, 'light'),
      dark: mapMode(parsed.colors, opts.base.modes.dark, 'dark'),
    },
  };
  return { ok: true, theme: repairContrast(theme) };
}
