import type { ITheme } from '@xterm/xterm';
import { ensureContrast, luminance, mix, parseColor, readableOn } from './color.ts';
import { repairContrast } from './repair.ts';
import { importSlackTheme } from './slack.ts';
import type { Theme, ThemeMode, TokenMap } from './types.ts';

/**
 * Theme import from the user's other tools (iTerm2, Ghostty, Warp, VS Code, Cursor,
 * Terminal.app). The backend reads their files read only and returns these shapes
 * (`theme_import_detect`, `theme_import_file`). Nothing here writes anything outside prefs.
 */

/** A terminal palette. Colors are `#rrggbb`. `ansi` is black..white, then the bright eight. */
export interface ImportPalette {
  background: string;
  foreground: string;
  cursor?: string;
  selection?: string;
  ansi: string[];
}

/** One importable look from one tool. */
export interface ImportEntry {
  id: string;
  name: string;
  /** `iterm2`, `ghostty`, `warp`, `vscode`, `cursor`, `terminal`, or `file` (a picked file). */
  source: string;
  palette: ImportPalette;
  font?: string;
  fontSize?: number;
  accent?: string;
}

/** One installed tool. Tools that are not installed are not listed. */
export interface ImportSource {
  id: string;
  name: string;
  entries: ImportEntry[];
  skipped: { name: string; reason: string }[];
}

/** A terminal palette kept in prefs (`termPalettes`). Its palette id is `import:<id>`. */
export interface StoredTermPalette {
  id: string;
  name: string;
  source: string;
  palette: ImportPalette;
}

export const IMPORT_PREFIX = 'import:';

const HEX = /^#[0-9a-f]{6}$/i;
const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

/** A palette from untrusted data, or null. */
export function cleanPalette(raw: unknown): ImportPalette | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const hex = (v: unknown) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined);
  const background = hex(r.background);
  const foreground = hex(r.foreground);
  const ansi = Array.isArray(r.ansi) ? r.ansi.map(hex) : [];
  if (!background || !foreground || ansi.length !== 16 || ansi.some((c) => !c)) return null;
  return {
    background,
    foreground,
    cursor: hex(r.cursor),
    selection: hex(r.selection),
    ansi: ansi as string[],
  };
}

/** Stored palettes from prefs, dropping anything malformed. */
export function cleanStoredPalettes(raw: unknown): StoredTermPalette[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredTermPalette[] = [];
  for (const v of raw) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    const palette = cleanPalette(r.palette);
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || !palette) continue;
    out.push({
      id: r.id,
      name: r.name,
      source: typeof r.source === 'string' ? r.source : '',
      palette,
    });
  }
  return out;
}

/** The palette as xterm options. Exact colors: they are the user's own. */
export function paletteToXterm(p: ImportPalette): ITheme {
  const t: ITheme = {
    background: p.background,
    foreground: p.foreground,
    cursor: p.cursor ?? p.foreground,
    cursorAccent: p.background,
    selectionBackground: p.selection ?? mix(p.background, p.foreground, 0.3),
  };
  ANSI_NAMES.forEach((n, i) => {
    t[n] = p.ansi[i];
  });
  return t;
}

/** Dark when the background is closer to black than to white. */
export function paletteMode(p: ImportPalette): ThemeMode {
  return luminance(parseColor(p.background)) < 0.18 ? 'dark' : 'light';
}

/** The tool's accent, else its bright blue (dark) or blue (light). */
export function paletteAccent(e: Pick<ImportEntry, 'palette' | 'accent'>): string {
  if (e.accent && HEX.test(e.accent)) return e.accent.toLowerCase();
  return paletteMode(e.palette) === 'dark' ? e.palette.ansi[12] : e.palette.ansi[4];
}

/**
 * An app theme from a terminal look: the terminal's background and text drive the matching
 * mode's surfaces, its accent drives the sidebar's active row, buttons and links. The other mode
 * comes from `base` with the same accent. Failing text pairs are repaired to WCAG AA,
 * foreground only, so the result passes `parseTheme(..., { requireAA: true })`.
 */
export function deriveAppTheme(
  e: ImportEntry,
  opts: { base: Theme; id: string; name: string },
): Theme {
  const p = e.palette;
  const mode = paletteMode(p);
  const accent = paletteAccent(e);
  const bg = p.background;
  const fg = ensureContrast(p.foreground, bg);
  // Sidebar band: the terminal ground pushed darker (dark looks) or the accent deepened (light).
  const side = mode === 'dark' ? mix(bg, '#000000', 0.35) : mix(accent, '#000000', 0.45);
  const sideFg = readableOn(side);
  const top = mix(side, '#000000', 0.25);
  const slack = [
    side,
    mix(side, sideFg, 0.1),
    accent,
    readableOn(accent),
    mix(side, sideFg, 0.1),
    sideFg,
    p.ansi[10],
    p.ansi[1],
    top,
    readableOn(top),
  ].join(',');
  const r = importSlackTheme(slack, opts);
  // The slack string is built from 6-digit hex colors, so it always parses.
  const theme: Theme = r.ok
    ? r.theme
    : { schemaVersion: 1, id: opts.id, name: opts.name, modes: opts.base.modes };
  const t: TokenMap = { ...theme.modes[mode] };
  t.bg = bg;
  t.fg = fg;
  t.surface = mix(bg, fg, 0.04);
  t.frame = mix(bg, mode === 'dark' ? '#000000' : fg, 0.1);
  t.line = mix(bg, fg, 0.16);
  t.hover = mix(bg, fg, 0.07);
  t.sel = mix(bg, p.selection ?? accent, 0.35);
  t.muted = ensureContrast(mix(fg, bg, 0.35), bg);
  t['code-bg'] = mix(bg, fg, 0.06);
  t['box-bg'] = mix(bg, fg, 0.03);
  t['box-line'] = mix(bg, fg, 0.22);
  t['art-bg'] = mix(bg, fg, 0.03);
  t['art-sheet'] = bg;
  t['accent-text'] = ensureContrast(accent, bg);
  t.link = ensureContrast(accent, bg);
  return repairContrast({
    ...theme,
    description: `Imported from ${e.name}.`,
    modes: { ...theme.modes, [mode]: t },
  });
}

/** Browser and Playwright: what a machine with iTerm2, Ghostty and Terminal.app would list. */
export const MOCK_IMPORT_SOURCES: ImportSource[] = [
  {
    id: 'iterm2',
    name: 'iTerm2',
    entries: [
      {
        id: 'iterm2:tokyo-night',
        name: 'Tokyo Night',
        source: 'iterm2',
        palette: {
          background: '#1a1b26',
          foreground: '#c0caf5',
          cursor: '#c0caf5',
          selection: '#33467c',
          ansi: [
            '#15161e',
            '#f7768e',
            '#9ece6a',
            '#e0af68',
            '#7aa2f7',
            '#bb9af7',
            '#7dcfff',
            '#a9b1d6',
            '#414868',
            '#f7768e',
            '#9ece6a',
            '#e0af68',
            '#7aa2f7',
            '#bb9af7',
            '#7dcfff',
            '#c0caf5',
          ],
        },
        font: 'JetBrains Mono',
        fontSize: 14,
      },
    ],
    skipped: [],
  },
  {
    id: 'ghostty',
    name: 'Ghostty',
    entries: [
      {
        id: 'ghostty:config',
        name: 'Current config',
        source: 'ghostty',
        palette: {
          background: '#fdf6e3',
          foreground: '#586e75',
          ansi: [
            '#073642',
            '#dc322f',
            '#859900',
            '#b58900',
            '#268bd2',
            '#d33682',
            '#2aa198',
            '#eee8d5',
            '#002b36',
            '#cb4b16',
            '#586e75',
            '#657b83',
            '#839496',
            '#6c71c4',
            '#93a1a1',
            '#fdf6e3',
          ],
        },
        font: 'Fira Code',
        fontSize: 15,
      },
    ],
    skipped: [{ name: 'Theme Gone', reason: 'the theme file was not found' }],
  },
  {
    id: 'terminal',
    name: 'Terminal',
    entries: [],
    skipped: [{ name: 'Pattern', reason: 'BackgroundColor could not be decoded' }],
  },
];

/** The picked-file fixture for `theme_import_file` in the mock. */
export const MOCK_IMPORT_FILE: ImportEntry = {
  id: 'file:solarized-dark',
  name: 'Solarized Dark',
  source: 'file',
  palette: {
    background: '#002b36',
    foreground: '#839496',
    ansi: [
      '#073642',
      '#dc322f',
      '#859900',
      '#b58900',
      '#268bd2',
      '#d33682',
      '#2aa198',
      '#eee8d5',
      '#002b36',
      '#cb4b16',
      '#586e75',
      '#657b83',
      '#839496',
      '#6c71c4',
      '#93a1a1',
      '#fdf6e3',
    ],
  },
};
