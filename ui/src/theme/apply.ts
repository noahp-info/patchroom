import { presetVars } from './presets.ts';
import { TOKEN_KEYS } from './tokens.ts';
import type { BaseId, Theme, ThemeMode } from './types.ts';

export type ModePreference = ThemeMode | 'system';

export function resolveMode(pref: ModePreference, systemPrefersDark: boolean): ThemeMode {
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}

/**
 * CSS custom properties for one mode, keyed `--name`. A cable preset replaces `--cable` and
 * `--plug` only; every other token stays the theme's.
 */
export function themeVars(
  theme: Theme,
  mode: ThemeMode,
  cablePreset?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const tokens = theme.modes[mode];
  for (const k of TOKEN_KEYS) out[`--${k}`] = tokens[k];
  return { ...out, ...presetVars(cablePreset, mode) };
}

/**
 * Put a base and a color theme on an element. Swapping the theme only rewrites color variables;
 * the base attribute is the only thing that changes layout.
 */
export function applyTheme(el: HTMLElement, theme: Theme, mode: ThemeMode, base?: BaseId): void {
  if (base) el.dataset.base = base;
  el.dataset.mode = mode;
  el.dataset.theme = theme.id;
  el.style.colorScheme = mode;
  for (const [k, v] of Object.entries(themeVars(theme, mode))) el.style.setProperty(k, v);
}

/** Static CSS for a theme, for contexts without JS: a light block, then a dark block. */
export function themeToCss(theme: Theme, selector = '.pr-app'): string {
  const block = (sel: string, mode: ThemeMode) =>
    `${sel} {\n  color-scheme: ${mode};\n${Object.entries(themeVars(theme, mode))
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n')}\n}\n`;
  return (
    block(`${selector}[data-theme='${theme.id}'][data-mode='light']`, 'light') +
    block(`${selector}[data-theme='${theme.id}'][data-mode='dark']`, 'dark')
  );
}
