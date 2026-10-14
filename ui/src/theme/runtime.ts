import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { usePrefs } from '../components/prefs/store.ts';
import { activeBase, activeTheme } from './active.ts';
import { resolveMode, themeVars } from './apply.ts';
import type { BaseId, Theme, ThemeMode } from './types.ts';

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

export interface ThemeRuntime {
  base: BaseId;
  theme: Theme;
  mode: ThemeMode;
  /** Inline style for the `.pr-app` root: every color token plus `color-scheme`. */
  style: CSSProperties;
}

/**
 * The app theme from prefs, live. Put `style`, `data-theme`, `data-mode` and `data-base` on the
 * `.pr-app` root and the whole app restyles the moment the picker changes.
 */
export function useThemeRuntime(): ThemeRuntime {
  const prefs = usePrefs();
  const dark = useSystemDark();
  const theme = useMemo(() => activeTheme(prefs), [prefs]);
  const mode = resolveMode(prefs.mode, dark);
  const style = useMemo(
    () => ({ ...themeVars(theme, mode, prefs.cablePreset), colorScheme: mode }) as CSSProperties,
    [theme, mode, prefs.cablePreset],
  );
  return { base: activeBase(prefs), theme, mode, style };
}
