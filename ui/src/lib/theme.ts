import { DEFAULT_BASE, validateTheme } from './../theme/index.ts';
import type { BaseId, Theme } from './../theme/index.ts';

// The shipped Homeroom color theme is a data-only plugin; load it the way theme-preview does.
const files = import.meta.glob('../../../plugins/themes/homeroom/themes/homeroom.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

export interface LoadedTheme {
  base: BaseId;
  theme: Theme;
}

export function loadDefaultTheme(): LoadedTheme {
  for (const data of Object.values(files)) {
    const r = validateTheme(data);
    if (r.ok) return { base: DEFAULT_BASE, theme: r.theme };
    throw new Error(`Homeroom theme is invalid: ${r.errors.join('; ')}`);
  }
  throw new Error('Homeroom theme file is missing');
}
