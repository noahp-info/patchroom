import { DEFAULT_BASE } from './bases.ts';
import { resolveMode } from './apply.ts';
import { validateTheme } from './validate.ts';
import type { BaseId, Theme, ThemeMode } from './types.ts';
import type { Prefs } from '../components/prefs/ipc.ts';

// The four shipped color themes are data-only plugins. Load them the way theme-preview does.
const files = import.meta.glob('../../../plugins/themes/*/themes/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const ORDER = ['homeroom', 'patch-bay', 'ansi-slate', 'cool-paper'];
let shipped: Theme[] | null = null;

/** The shipped themes in picker order. Invalid files are skipped. */
export function shippedThemes(): Theme[] {
  if (shipped) return shipped;
  const out: Theme[] = [];
  for (const data of Object.values(files)) {
    const r = validateTheme(data);
    if (r.ok) out.push(r.theme);
  }
  out.sort((a, b) => {
    const ia = ORDER.indexOf(a.id);
    const ib = ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  });
  shipped = out;
  return out;
}

/** Shipped themes, then the user's custom themes that validate. */
export function allThemes(prefs: Pick<Prefs, 'customThemes'>): Theme[] {
  const ship = shippedThemes();
  const custom = prefs.customThemes.filter((t) => validateTheme(t).ok);
  return [...ship, ...custom.filter((c) => !ship.some((s) => s.id === c.id))];
}

/** The chosen theme, or Homeroom when the id no longer exists. */
export function activeTheme(prefs: Pick<Prefs, 'themeId' | 'customThemes'>): Theme {
  const list = allThemes(prefs);
  return list.find((t) => t.id === prefs.themeId) ?? list[0];
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The light or dark mode in force right now. */
export function currentMode(prefs: Pick<Prefs, 'mode'>): ThemeMode {
  return resolveMode(prefs.mode, systemPrefersDark());
}

export const ACTIVE_BASE: BaseId = DEFAULT_BASE;
