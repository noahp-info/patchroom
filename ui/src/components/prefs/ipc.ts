import type { Theme } from '../../theme/types.ts';

/** Patchroom events that can make a sound or a notification. */
export const SOUND_EVENTS = ['needs', 'done', 'message', 'error', 'bell'] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

export type NotifyLevel = 'all' | 'needs' | 'mute';
export type ModePref = 'light' | 'dark' | 'system';

/** Days are 0 (Sunday) to 6 (Saturday), local time. Start and end are "HH:MM". */
export interface DndSchedule {
  days: number[];
  start: string;
  end: string;
}

export interface TermStyle {
  themeId?: string;
  font?: string;
  fontSize?: number;
}

/** The P3 `Prefs` contract (camelCase JSON), exactly as `prefs_get` returns it. */
export interface Prefs {
  themeId: string;
  mode: ModePref;
  customThemes: Theme[];
  notify: { default: NotifyLevel; perDm: Record<string, NotifyLevel> };
  sound: {
    enabled: boolean;
    volume: number;
    perEvent: Record<string, { on: boolean; sound: string }>;
    perDm: Record<string, 'default' | 'mute'>;
    hookPolicy: Record<string, 'keep' | 'both'>;
  };
  dnd: { manual: boolean; schedule: DndSchedule | null };
  termPerDm: Record<string, TermStyle>;
  searchAllSessions: boolean;
}

/** One row of `sound_hooks_detect`: a command hook of the user's that plays audio. */
export interface HookDetect {
  event: string;
  command: string;
  source: string;
}

/** `termPerDm` key that holds the default for every DM without its own entry. */
export const TERM_DEFAULT_KEY = '*';

export const DEFAULT_PREFS: Prefs = {
  themeId: 'homeroom',
  mode: 'system',
  customThemes: [],
  notify: { default: 'all', perDm: {} },
  sound: {
    enabled: true,
    volume: 0.6,
    perEvent: {
      needs: { on: true, sound: 'needs' },
      done: { on: true, sound: 'done' },
      message: { on: false, sound: 'message' },
      error: { on: true, sound: 'error' },
      bell: { on: true, sound: 'bell' },
    },
    perDm: {},
    hookPolicy: {},
  },
  dnd: { manual: false, schedule: null },
  termPerDm: {},
  searchAllSessions: false,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fill anything missing in stored or backend prefs from the defaults, one level deep per group. */
export function normalizePrefs(raw: unknown): Prefs {
  const r = isRecord(raw) ? raw : {};
  const d = DEFAULT_PREFS;
  const sound = isRecord(r.sound) ? r.sound : {};
  const notify = isRecord(r.notify) ? r.notify : {};
  const dnd = isRecord(r.dnd) ? r.dnd : {};
  return {
    ...d,
    ...(r as Partial<Prefs>),
    customThemes: Array.isArray(r.customThemes) ? (r.customThemes as Theme[]) : [],
    notify: { ...d.notify, ...(notify as Partial<Prefs['notify']>) },
    sound: {
      ...d.sound,
      ...(sound as Partial<Prefs['sound']>),
      perEvent: {
        ...d.sound.perEvent,
        ...(isRecord(sound.perEvent) ? (sound.perEvent as Prefs['sound']['perEvent']) : {}),
      },
    },
    dnd: { ...d.dnd, ...(dnd as Partial<Prefs['dnd']>) },
    termPerDm: isRecord(r.termPerDm) ? (r.termPerDm as Prefs['termPerDm']) : {},
  };
}

/** The commands and event the prefs layer uses. Real: Tauri invoke. Fallback: in-memory mock. */
export interface PrefsApi {
  prefsGet(): Promise<Prefs>;
  prefsSet(patch: Partial<Prefs>): Promise<Prefs>;
  soundHooksDetect(): Promise<HookDetect[]>;
  notifyTest(): Promise<void>;
  /** Subscribe to `prefs:changed`. */
  onPrefsChanged(handler: (prefs: Prefs) => void): Promise<() => void>;
}

/** Real backend: command names and payloads from docs/gauntlet/P3-BAR.md. */
export function createTauriPrefsApi(): PrefsApi {
  return {
    async prefsGet() {
      const { invoke } = await import('@tauri-apps/api/core');
      return normalizePrefs(await invoke('prefs_get'));
    },
    async prefsSet(patch) {
      const { invoke } = await import('@tauri-apps/api/core');
      return normalizePrefs(await invoke('prefs_set', { patch }));
    },
    async soundHooksDetect() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<HookDetect[]>('sound_hooks_detect');
    },
    async notifyTest() {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('notify_test');
    },
    async onPrefsChanged(handler) {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<{ prefs: Prefs }>('prefs:changed', (e) =>
        handler(normalizePrefs(e.payload.prefs)),
      );
    },
  };
}

export interface MockPrefsOptions {
  detected?: HookDetect[];
  /** Persist in localStorage under this key so a reload keeps the prefs. */
  storageKey?: string;
}

/** In-memory backend for the browser and Playwright. Records `notify_test` calls. */
export function createMockPrefsApi(opts: MockPrefsOptions = {}): PrefsApi & {
  notifyTests: number;
} {
  const key = opts.storageKey;
  let prefs = DEFAULT_PREFS;
  if (key) {
    try {
      const s = localStorage.getItem(key);
      if (s) prefs = normalizePrefs(JSON.parse(s));
    } catch {
      // storage can be blocked; start from defaults
    }
  }
  const handlers = new Set<(p: Prefs) => void>();
  const api = {
    notifyTests: 0,
    prefsGet: () => Promise.resolve(prefs),
    prefsSet(patch: Partial<Prefs>) {
      prefs = normalizePrefs({ ...prefs, ...patch });
      if (key) {
        try {
          localStorage.setItem(key, JSON.stringify(prefs));
        } catch {
          // ignore
        }
      }
      for (const h of handlers) h(prefs);
      return Promise.resolve(prefs);
    },
    soundHooksDetect: () => Promise.resolve(opts.detected ?? []),
    notifyTest() {
      api.notifyTests += 1;
      return Promise.resolve();
    },
    onPrefsChanged(handler: (p: Prefs) => void) {
      handlers.add(handler);
      return Promise.resolve(() => void handlers.delete(handler));
    },
  };
  return api;
}

/** Tauri inside the webview unless `?mock` forces the mock, like `createIpc`. */
export function createPrefsApi(): PrefsApi {
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const mock = new URLSearchParams(window.location.search).has('mock');
  return inTauri && !mock ? createTauriPrefsApi() : createMockPrefsApi({ storageKey: 'pr.prefs' });
}
