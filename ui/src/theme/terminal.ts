import type { ITheme } from '@xterm/xterm';
import { TERM_DEFAULT_KEY, type Prefs } from '../components/prefs/ipc.ts';
import { getPrefsStore } from '../components/prefs/store.ts';
import { activeTheme, allThemes, currentMode } from './active.ts';
import { ensureContrast, mix } from './color.ts';
import { IMPORT_PREFIX, paletteToXterm } from './themeImport.ts';
import type { Theme, ThemeMode } from './types.ts';

export interface TermPalette {
  id: string;
  name: string;
}

/** Palette ids: fixed presets, `app` (follow the app theme), or `theme:<id>` (a specific theme). */
export const FIXED_PALETTES: readonly TermPalette[] = [
  { id: 'app', name: 'Match app theme' },
  { id: 'iterm', name: 'iTerm Dark' },
  { id: 'solarized-dark', name: 'Solarized Dark' },
  { id: 'solarized-light', name: 'Solarized Light' },
];
export const DEFAULT_PALETTE = 'app';

export const TERM_FONTS = ['JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Courier New'] as const;
export const DEFAULT_FONT = 'JetBrains Mono';
export const DEFAULT_FONT_SIZE = 13;
export const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18] as const;

// Terminal palettes are data: xterm needs literal colors. They never reach CSS.
const ITERM: ITheme = {
  background: '#000000',
  foreground: '#c7c7c7',
  cursor: '#c7c7c7',
  cursorAccent: '#000000',
  selectionBackground: '#c1deff',
  selectionForeground: '#000000',
  black: '#000000',
  red: '#c91b00',
  green: '#00c200',
  yellow: '#c7c400',
  blue: '#0225c7',
  magenta: '#c930c7',
  cyan: '#00c5c7',
  white: '#c7c7c7',
  brightBlack: '#676767',
  brightRed: '#ff6d67',
  brightGreen: '#5ff967',
  brightYellow: '#fefb67',
  brightBlue: '#6871ff',
  brightMagenta: '#ff76ff',
  brightCyan: '#5ffdff',
  brightWhite: '#ffffff',
};

const SOLARIZED_ANSI = {
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
};

const SOLARIZED_DARK: ITheme = {
  background: '#002b36',
  foreground: '#93a1a1',
  cursor: '#93a1a1',
  cursorAccent: '#002b36',
  selectionBackground: '#164b57',
  black: '#073642',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightWhite: '#fdf6e3',
  ...SOLARIZED_ANSI,
  brightRed: '#e8605d',
  brightGreen: '#a2b800',
  brightYellow: '#d3a417',
  brightBlue: '#4aa3df',
  brightMagenta: '#e35f9d',
  brightCyan: '#4cbab1',
};

const SOLARIZED_LIGHT: ITheme = {
  background: '#fdf6e3',
  foreground: '#586e75',
  cursor: '#586e75',
  cursorAccent: '#fdf6e3',
  selectionBackground: '#e4ddc6',
  black: '#073642',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightWhite: '#fdf6e3',
  red: '#cb2b28',
  green: '#6b7a00',
  yellow: '#8a6700',
  blue: '#1f78b4',
  magenta: '#c02a74',
  cyan: '#1f8079',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#268bd2',
  brightMagenta: '#6c71c4',
  brightCyan: '#2a8f89',
};

/** An ANSI palette read from a theme's tokens, every color held to 4.5:1 on its background. */
export function paletteFromTheme(theme: Theme, mode: ThemeMode): ITheme {
  const t = theme.modes[mode];
  const bg = t['code-bg'];
  const fg = t.fg;
  const on = (c: string) => ensureContrast(c, bg);
  const red = on(t['c-red']);
  const green = on(t['c-green']);
  const yellow = on(t['c-yellow']);
  const blue = on(t['c-blue']);
  const magenta = on(mix(red, blue, 0.5));
  const cyan = on(mix(green, blue, 0.5));
  const lift = (c: string) => ensureContrast(mix(c, fg, 0.25), bg);
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: t.sel,
    black: mix(bg, fg, 0.12),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: on(mix(fg, bg, 0.2)),
    brightBlack: on(mix(bg, fg, 0.55)),
    brightRed: lift(red),
    brightGreen: lift(green),
    brightYellow: lift(yellow),
    brightBlue: lift(blue),
    brightMagenta: lift(magenta),
    brightCyan: lift(cyan),
    brightWhite: fg,
  };
}

export interface ResolvedTermStyle {
  paletteId: string;
  theme: ITheme;
  font: string;
  fontFamily: string;
  fontSize: number;
}

/** The effective palette ids for one DM: its own, else the default row, else `app`. */
export function termStyleFor(prefs: Prefs, dmId: string | null): ResolvedTermStyle {
  const own = (dmId && prefs.termPerDm[dmId]) || {};
  const def = prefs.termPerDm[TERM_DEFAULT_KEY] ?? {};
  const paletteId = own.themeId ?? def.themeId ?? DEFAULT_PALETTE;
  // A session's own font wins; else Settings > Themes > Fonts > Code and terminal.
  const code = prefs.fonts?.code ?? {};
  const font = own.font ?? code.family ?? def.font ?? DEFAULT_FONT;
  const fontSize = own.fontSize ?? code.size ?? def.fontSize ?? DEFAULT_FONT_SIZE;
  const mode = currentMode(prefs);
  let theme: ITheme;
  if (paletteId === 'iterm') theme = ITERM;
  else if (paletteId === 'solarized-dark') theme = SOLARIZED_DARK;
  else if (paletteId === 'solarized-light') theme = SOLARIZED_LIGHT;
  else if (paletteId.startsWith(IMPORT_PREFIX)) {
    const id = paletteId.slice(IMPORT_PREFIX.length);
    const found = (prefs.termPalettes ?? []).find((p) => p.id === id);
    theme = found ? paletteToXterm(found.palette) : paletteFromTheme(activeTheme(prefs), mode);
  } else if (paletteId.startsWith('theme:')) {
    const id = paletteId.slice(6);
    theme = paletteFromTheme(allThemes(prefs).find((t) => t.id === id) ?? activeTheme(prefs), mode);
  } else theme = paletteFromTheme(activeTheme(prefs), mode);
  return {
    paletteId,
    theme,
    font,
    // Settings > Themes > Emoji in chat also styles the terminal. The text fonts come first, so
    // only glyphs they lack (emoji) fall through to the bundled Noto.
    fontFamily:
      prefs.emoji?.chat === 'noto'
        ? `"${font}", Menlo, Monaco, "Courier New", "Noto Color Emoji Patchroom", monospace`
        : `"${font}", Menlo, Monaco, "Courier New", monospace`,
    fontSize,
  };
}

/** The slice of an xterm `Terminal` this module touches. */
export interface StylableTerm {
  options: { theme?: ITheme; fontFamily?: string; fontSize?: number };
  refresh?(start: number, end: number): void;
  rows?: number;
}

/** Restyle one live xterm instance from the current prefs. No restart, no redraw gap. */
export function applyTerminalTheme(term: StylableTerm, dmId: string): ResolvedTermStyle {
  const s = termStyleFor(getPrefsStore().getPrefs(), dmId);
  term.options.theme = s.theme;
  if (term.options.fontFamily !== s.fontFamily) term.options.fontFamily = s.fontFamily;
  if (term.options.fontSize !== s.fontSize) term.options.fontSize = s.fontSize;
  term.refresh?.(0, Math.max(0, (term.rows ?? 1) - 1));
  return s;
}

/**
 * Apply now, then again on every prefs change and system light/dark flip. `onApplied` runs after
 * each apply so the owner can refit the grid after a font change. Returns the unsubscribe.
 */
export function bindTerminalTheme(
  term: StylableTerm,
  dmId: string,
  onApplied?: (s: ResolvedTermStyle) => void,
): () => void {
  const store = getPrefsStore();
  const run = () => onApplied?.(applyTerminalTheme(term, dmId));
  run();
  const off = store.subscribe(run);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', run);
  return () => {
    off();
    mq.removeEventListener('change', run);
  };
}
