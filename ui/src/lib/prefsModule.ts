import { useEffect, useMemo, useState, type ComponentType, type CSSProperties } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { resolveMode, themeVars, DEFAULT_BASE } from '../theme/index.ts';
import type { BaseId, Theme, ThemeMode } from '../theme/index.ts';
import type { Ipc, Prefs } from '../ipc';
import { loadDefaultTheme } from './theme';

/**
 * The prefs piece (ui/src/components/prefs/, ui/src/sound/, ui/src/theme/runtime.ts) builds in
 * parallel. Its index is found at build time with a glob, so a tree without it still compiles:
 * the pane shows a placeholder, sounds stay silent and the theme falls back to Homeroom.
 */
const found = import.meta.glob('../components/prefs/index.ts', { eager: true }) as Record<
  string,
  unknown
>;

export interface ThemeRuntime {
  base: BaseId;
  theme: Theme;
  mode: ThemeMode;
  style: CSSProperties;
}

/** What `<PrefsPane>` takes from the workspace. */
export interface PrefsPaneProps {
  onClose(): void;
  dms?: { id: string; name: string }[];
}

interface PrefsApi {
  prefsGet(): Promise<Prefs>;
  prefsSet(patch: Partial<Prefs>): Promise<Prefs>;
  soundHooksDetect(): Promise<{ event: string; command: string; source: string }[]>;
  notifyTest(): Promise<void>;
  onPrefsChanged(handler: (prefs: Prefs) => void): Promise<() => void>;
}

interface PrefsExports {
  PrefsPane?: ComponentType<PrefsPaneProps>;
  playSound?: (event: string, opts?: { dmId?: string }) => unknown;
  useThemeRuntime?: () => ThemeRuntime;
  setPrefsApi?: (api: PrefsApi) => unknown;
  bindTerminalTheme?: (
    term: XTerm,
    dmId: string,
    onApplied?: (s: { theme: { background?: string } }) => void,
  ) => () => void;
}

const mod: PrefsExports = (Object.values(found)[0] as PrefsExports | undefined) ?? {};

export const PrefsPane: ComponentType<PrefsPaneProps> | null = mod.PrefsPane ?? null;

function useFallbackThemeRuntime(): ThemeRuntime {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const { theme } = useMemo(() => loadDefaultTheme(), []);
  const mode = resolveMode('system', dark);
  const style = useMemo(
    () => ({ ...themeVars(theme, mode), colorScheme: mode }) as CSSProperties,
    [theme, mode],
  );
  return { base: DEFAULT_BASE, theme, mode, style };
}

/** The app theme from prefs, live. The choice of hook is fixed at build time. */
export const useThemeRuntime: () => ThemeRuntime = mod.useThemeRuntime ?? useFallbackThemeRuntime;

/** Point the prefs layer at the app's IPC, so the pane and the backend share one `Prefs`. */
export function installPrefsApi(ipc: Ipc): void {
  mod.setPrefsApi?.({
    prefsGet: () => ipc.prefsGet(),
    prefsSet: (patch) => ipc.prefsSet(patch),
    soundHooksDetect: () => ipc.soundHooksDetect(),
    notifyTest: () => ipc.notifyTest(),
    onPrefsChanged: (handler) => ipc.on('prefs:changed', (e) => handler(e.prefs)),
  });
}

/** Restyle one terminal from prefs now and on every change. Returns the unbind. */
export function bindTerminalStyle(
  term: XTerm,
  dmId: string,
  onApplied: (background: string | undefined) => void,
): () => void {
  try {
    return (
      mod.bindTerminalTheme?.(term, dmId, (s) => onApplied(s.theme.background)) ?? (() => undefined)
    );
  } catch {
    return () => undefined;
  }
}

declare global {
  interface Window {
    /** Every sound the UI was asked to play, for tests and the judge's sound log. */
    __PR_SOUND_LOG__?: { event: string; id: string; at: number }[];
  }
}

/** `notify:fire` arrived: the backend already decided to alert, the UI plays the sound. */
export function playNotifySound(event: string, id: string): void {
  (window.__PR_SOUND_LOG__ ??= []).push({ event, id, at: Date.now() });
  try {
    mod.playSound?.(event, { dmId: id || undefined });
  } catch {
    // Sound is best effort.
  }
}
