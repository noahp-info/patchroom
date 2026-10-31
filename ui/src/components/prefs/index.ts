export { PrefsPane } from './PrefsPane.tsx';
export type { PrefsPaneProps } from './PrefsPane.tsx';
export type { PrefsDm } from './types.ts';
export { getPrefsStore, setPrefsApi, usePrefs, usePrefsState, PrefsStore } from './store.ts';
export {
  DEFAULT_PREFS,
  SOUND_EVENTS,
  TERM_DEFAULT_KEY,
  createMockPrefsApi,
  createPrefsApi,
  createTauriPrefsApi,
  normalizePrefs,
} from './ipc.ts';
export type {
  DndSchedule,
  HookDetect,
  ModePref,
  NotifyLevel,
  Prefs,
  PrefsApi,
  SoundEvent,
  TermStyle,
} from './ipc.ts';
export { playSound } from '../../sound/index.ts';
export { applyTerminalTheme, bindTerminalTheme } from '../../theme/terminal.ts';
export { useThemeRuntime } from '../../theme/runtime.ts';
