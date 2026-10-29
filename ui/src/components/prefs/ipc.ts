import { DEFAULT_BASE, getBase } from '../../theme/bases.ts';
import type {
  EmojiFlavor,
  HistoryGroup,
  ModelCatalog,
  ModelPrefs,
  ModuleLabel,
  UpdateInfo,
  UpdatePrefs,
} from '../../ipc/types.ts';
import {
  createMockSoundBackend,
  type MockSoundBackend,
  type MockSoundOptions,
} from '../../ipc/mockSounds.ts';
import type { BaseId, Theme } from '../../theme/types.ts';
import {
  cleanStoredPalettes,
  MOCK_IMPORT_FILE,
  MOCK_IMPORT_SOURCES,
  type ImportEntry,
  type ImportSource,
  type StoredTermPalette,
} from '../../theme/themeImport.ts';
import {
  cleanFonts,
  MOCK_SYSTEM_FONTS,
  validFamily,
  type FontOption,
  type FontPrefs,
} from '../../theme/typeface.ts';

/** Patchroom events that can make a sound or a notification. */
export const SOUND_EVENTS = [
  'needs',
  'done',
  'message',
  'error',
  'bell',
  'decision',
  'due',
  'session',
] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

/** The pack every event uses until the user mixes it. */
export const DEFAULT_PACK = 'patchtones';

/** What one event plays: a pack's sound, the user's own file (its id), or nothing. */
export type MixChoice = { pack: string; gain?: number } | { custom: string; gain?: number } | 'off';

/** The per-event volume range: a 0 to 1.5 multiplier, 1 when absent. */
export const GAIN_MAX = 1.5;

/** What `sound_file` and `sound_custom_file` return. `norm` levels the file; `peak` is its loudest sample (0 to 1). */
export interface SoundFileData {
  dataUrl: string;
  /** Normalizing gain (the backend's `norm`): 1 for bundled files, which ship leveled. */
  norm?: number;
  /** Loudest sample after the normalizing gain, linear. Bundled files peak at 0.75 or lower. */
  peak?: number;
}

/** A DM's own sound setup: the global mix, muted, or a pack and/or single events of its own. */
export type DmSoundPref =
  'default' | 'mute' | { pack?: string; mix?: Partial<Record<SoundEvent, MixChoice>> };

export type PackKind = 'generated' | 'files' | 'imported';

/** One row of `sound_packs`. */
export interface PackInfo {
  id: string;
  name: string;
  description: string;
  kind: PackKind;
  license: string;
  author: string;
  /** Where the sounds come from, for the credits. */
  source?: string;
  events: Partial<Record<SoundEvent, boolean>>;
}

/** One row of `sound_claude_profiles` (read only). */
export interface ClaudeProfile {
  id: string;
  name: string;
  events: SoundEvent[];
}

export interface ImportedFile {
  id: string;
  name: string;
  durationMs: number;
  /** Normalizing gain (`norm`) that brings the file to the shared level. The file is unchanged. */
  norm?: number;
  /** Loudest sample after the normalizing gain, linear (about 0.7 when leveled). */
  peak?: number;
}

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
  /** Layout base: Homeroom or Patch Bay. */
  base: BaseId;
  /** Patch Bay cable and plug preset id, or `theme` to follow the theme's own tokens. */
  cablePreset: string;
  notify: { default: NotifyLevel; perDm: Record<string, NotifyLevel> };
  sound: {
    enabled: boolean;
    volume: number;
    perEvent: Record<string, { on: boolean; sound: string }>;
    /** Per event: a pack's sound, the user's own file or off. */
    mix: Record<string, MixChoice>;
    perDm: Record<string, DmSoundPref>;
    hookPolicy: Record<string, 'keep' | 'both'>;
  };
  dnd: { manual: boolean; schedule: DndSchedule | null };
  termPerDm: Record<string, TermStyle>;
  searchAllSessions: boolean;
  statusBar?: {
    default: string[] | null;
    perDm: Record<string, string[]>;
    labels?: Record<string, ModuleLabel>;
    /** Options of the built-in modules: module id to option to value. */
    options?: Record<string, Record<string, string>>;
  };
  sidebarWidth: number;
  /** Where a plain click opens a link. Cmd-click opens it in the other place. */
  links: { open: LinkTarget };
  /** Pin each claude.ai artifact once when it appears. */
  artifacts: { autoPin: boolean };
  /** First-time hints already shown (ids). */
  hints: { seen: string[] };
  /** Terminal palettes imported from other tools. Palette id `import:<id>`. */
  termPalettes: StoredTermPalette[];
  /** Model bundles, overrides and labels. */
  models?: ModelPrefs;
  /** Opt-in network checks (both off by default). */
  updates?: UpdatePrefs;
  /** How emoji in chat are drawn. */
  emoji?: { chat: EmojiFlavor };
  /** Chat view: logs follow new messages. */
  chat?: { autoScroll: boolean; carryDraft?: boolean };
  /** Fonts per area, and the chat font per section or session (Settings > Themes > Fonts). */
  fonts?: FontPrefs;
  /** The History panel's grouping. */
  history?: { groupBy: HistoryGroup };
}

export type LinkTarget = 'patchroom' | 'browser';

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
  base: DEFAULT_BASE,
  cablePreset: 'theme',
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
      decision: { on: true, sound: 'decision' },
      due: { on: true, sound: 'due' },
      session: { on: true, sound: 'session' },
    },
    mix: Object.fromEntries(SOUND_EVENTS.map((e) => [e, { pack: DEFAULT_PACK }])),
    perDm: {},
    hookPolicy: {},
  },
  dnd: { manual: false, schedule: null },
  termPerDm: {},
  searchAllSessions: false,
  statusBar: { default: null, perDm: {} },
  sidebarWidth: 264,
  links: { open: 'patchroom' },
  artifacts: { autoPin: true },
  hints: { seen: [] },
  termPalettes: [],
};

/** A stored gain, clamped to 0 to 1.5. Anything that is not a finite number is dropped. */
export function cleanGain(g: unknown): number | undefined {
  return typeof g === 'number' && Number.isFinite(g)
    ? Math.min(GAIN_MAX, Math.max(0, g))
    : undefined;
}

function cleanChoice(c: unknown): MixChoice {
  if (!isRecord(c)) return c as MixChoice;
  const { gain, ...rest } = c as { gain?: unknown } & Record<string, unknown>;
  const g = cleanGain(gain);
  return (g === undefined ? rest : { ...rest, gain: g }) as MixChoice;
}

function cleanPerDm(raw: Record<string, unknown>): Prefs['sound']['perDm'] {
  return Object.fromEntries(
    Object.entries(raw).map(([id, v]) => {
      if (!isRecord(v) || !isRecord(v.mix)) return [id, v];
      const mix = Object.fromEntries(Object.entries(v.mix).map(([e, c]) => [e, cleanChoice(c)]));
      return [id, { ...v, mix }];
    }),
  ) as Prefs['sound']['perDm'];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeStatusBar(raw: unknown): NonNullable<Prefs['statusBar']> {
  const r = isRecord(raw) ? raw : {};
  const list = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  const perDm: Record<string, string[]> = {};
  if (isRecord(r.perDm)) {
    for (const [k, v] of Object.entries(r.perDm)) {
      const l = list(v);
      if (l) perDm[k] = l;
    }
  }
  const out: NonNullable<Prefs['statusBar']> = { default: list(r.default), perDm };
  // Keep labels and module options: a save of one must not drop the others.
  if (isRecord(r.labels)) out.labels = r.labels as Record<string, ModuleLabel>;
  if (isRecord(r.options)) out.options = r.options as Record<string, Record<string, string>>;
  return out;
}

/**
 * Before fonts per area, the terminal's default font and size sat in `termPerDm['*']`. They
 * move to the Code and terminal area unless it has its own (the backend does the same on load).
 */
function migrateTermFont(
  termPerDm: Prefs['termPerDm'],
  fonts: FontPrefs,
): { termPerDm: Prefs['termPerDm']; fonts: FontPrefs } {
  const row = termPerDm[TERM_DEFAULT_KEY];
  if (!row || (row.font === undefined && row.fontSize === undefined)) return { termPerDm, fonts };
  const code = { ...fonts.code };
  if (!code.family && validFamily(row.font)) code.family = row.font;
  if (!code.size && typeof row.fontSize === 'number' && row.fontSize >= 8 && row.fontSize <= 32)
    code.size = row.fontSize;
  const rest = { ...termPerDm };
  if (row.themeId) rest[TERM_DEFAULT_KEY] = { themeId: row.themeId };
  else delete rest[TERM_DEFAULT_KEY];
  return {
    termPerDm: rest,
    fonts: code.family || code.size ? { ...fonts, code } : fonts,
  };
}

/** Fill anything missing in stored or backend prefs from the defaults, one level deep per group. */
export function normalizePrefs(raw: unknown): Prefs {
  const r = isRecord(raw) ? raw : {};
  const term = migrateTermFont(
    isRecord(r.termPerDm) ? (r.termPerDm as Prefs['termPerDm']) : {},
    cleanFonts(r.fonts),
  );
  const d = DEFAULT_PREFS;
  const sound = isRecord(r.sound) ? r.sound : {};
  const notify = isRecord(r.notify) ? r.notify : {};
  const dnd = isRecord(r.dnd) ? r.dnd : {};
  return {
    ...d,
    ...(r as Partial<Prefs>),
    customThemes: Array.isArray(r.customThemes) ? (r.customThemes as Theme[]) : [],
    // Prefs stored before bases and cable presets existed have no keys: Homeroom, follow the theme.
    base: typeof r.base === 'string' && getBase(r.base) ? (r.base as BaseId) : d.base,
    cablePreset: typeof r.cablePreset === 'string' ? r.cablePreset : d.cablePreset,
    notify: { ...d.notify, ...(notify as Partial<Prefs['notify']>) },
    links: {
      open: isRecord(r.links) && r.links.open === 'browser' ? 'browser' : 'patchroom',
    },
    artifacts: { autoPin: !(isRecord(r.artifacts) && r.artifacts.autoPin === false) },
    hints: {
      seen:
        isRecord(r.hints) && Array.isArray(r.hints.seen)
          ? r.hints.seen.filter((x): x is string => typeof x === 'string')
          : [],
    },
    termPalettes: cleanStoredPalettes(r.termPalettes),
    sound: {
      ...d.sound,
      ...(sound as Partial<Prefs['sound']>),
      perEvent: {
        ...d.sound.perEvent,
        ...(isRecord(sound.perEvent) ? (sound.perEvent as Prefs['sound']['perEvent']) : {}),
      },
      // Prefs from before sound packs have no mix: every event plays Patch Tones.
      mix: {
        ...d.sound.mix,
        ...(isRecord(sound.mix)
          ? (Object.fromEntries(
              Object.entries(sound.mix).map(([e, c]) => [e, cleanChoice(c)]),
            ) as Prefs['sound']['mix'])
          : {}),
      },
      perDm: isRecord(sound.perDm) ? cleanPerDm(sound.perDm) : {},
    },
    dnd: { ...d.dnd, ...(dnd as Partial<Prefs['dnd']>) },
    termPerDm: term.termPerDm,
    fonts: term.fonts,
    statusBar: normalizeStatusBar(r.statusBar),
  };
}

/** The commands and event the prefs layer uses. Real: Tauri invoke. Fallback: in-memory mock. */
export interface PrefsApi {
  prefsGet(): Promise<Prefs>;
  prefsSet(patch: Partial<Prefs>): Promise<Prefs>;
  soundHooksDetect(): Promise<HookDetect[]>;
  notifyTest(): Promise<void>;
  /** Sound packs: the commands of the SOUND-PACKS build bar. */
  soundPacks(): Promise<PackInfo[]>;
  /** A file or imported pack's audio. */
  soundFile(packId: string, event: string): Promise<SoundFileData>;
  /** The user's own sounds, newest first. */
  soundCustomList(): Promise<ImportedFile[]>;
  /** One of the user's own sounds. */
  soundCustomFile(id: string): Promise<SoundFileData>;
  /** The native file picker. Resolves null when cancelled. */
  soundPickFile(): Promise<string | null>;
  soundImportFile(path: string): Promise<ImportedFile>;
  soundCustomRemove(id: string): Promise<void>;
  soundClaudeProfiles(): Promise<ClaudeProfile[]>;
  soundImportClaudeProfile(id: string): Promise<{ packId: string }>;
  /** Theme import: the looks the user's installed tools offer. Read only. */
  themeImportDetect(): Promise<ImportSource[]>;
  /** Theme import: pick an `.itermcolors` file and read it. Null when cancelled. */
  themeImportFile(): Promise<ImportEntry | null>;
  /** Subscribe to `prefs:changed`. */
  onPrefsChanged(handler: (prefs: Prefs) => void): Promise<() => void>;
  /** The signed catalog fetched earlier, or null. Absent: none. */
  catalogGet?(): Promise<ModelCatalog | null>;
  /** Fetch and verify the signed catalog (only while the setting is on). */
  catalogRefresh?(): Promise<ModelCatalog>;
  /** Is a newer Patchroom published (only while the setting is on)? */
  updateCheck?(): Promise<UpdateInfo>;
  /** Installed font families (Core Text), read only. Absent: bundled faces only. */
  fontsList?(): Promise<FontOption[]>;
}

/** Real backend: command names and payloads from the P3 build bar. */
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
    async soundPacks() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<PackInfo[]>('sound_packs');
    },
    async soundFile(packId, event) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<SoundFileData>('sound_file', { packId, event });
    },
    async soundPickFile() {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Sound', extensions: ['wav', 'aiff', 'mp3', 'm4a'] }],
      });
      return typeof picked === 'string' ? picked : null;
    },
    async soundCustomList() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<ImportedFile[]>('sound_custom_list');
    },
    async soundCustomFile(id) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<SoundFileData>('sound_custom_file', { id });
    },
    async soundImportFile(path) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<ImportedFile>('sound_import_file', { path });
    },
    async soundCustomRemove(id) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('sound_custom_remove', { id });
    },
    async soundClaudeProfiles() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<ClaudeProfile[]>('sound_claude_profiles');
    },
    async soundImportClaudeProfile(id) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<{ packId: string }>('sound_import_claude_profile', { id });
    },
    async themeImportDetect() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<ImportSource[]>('theme_import_detect');
    },
    async themeImportFile() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<ImportEntry | null>('theme_import_file');
    },
    async catalogGet() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<ModelCatalog | null>('catalog_get');
    },
    async catalogRefresh() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<ModelCatalog>('catalog_refresh');
    },
    async updateCheck() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<UpdateInfo>('update_check');
    },
    async fontsList() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<FontOption[]>('fonts_list');
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
  /** Seed for the mock sound backend (profiles, picked files). */
  sound?: MockSoundOptions;
  detected?: HookDetect[];
  /** Persist in localStorage under this key so a reload keeps the prefs. */
  storageKey?: string;
  /** What `theme_import_detect` lists. Default: an iTerm2, Ghostty and Terminal fixture. */
  importSources?: ImportSource[];
}

/** In-memory backend for the browser and Playwright. Records `notify_test` calls. */
export function createMockPrefsApi(opts: MockPrefsOptions = {}): PrefsApi & {
  notifyTests: number;
  sound: MockSoundBackend;
} {
  const sound = createMockSoundBackend(opts.sound);
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
    sound,
    soundPacks: sound.soundPacks,
    soundFile: sound.soundFile,
    soundCustomList: sound.soundCustomList,
    soundCustomFile: sound.soundCustomFile,
    soundPickFile: sound.soundPickFile,
    soundImportFile: sound.soundImportFile,
    soundCustomRemove: sound.soundCustomRemove,
    soundClaudeProfiles: sound.soundClaudeProfiles,
    soundImportClaudeProfile: sound.soundImportClaudeProfile,
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
    themeImportDetect: () =>
      Promise.resolve(structuredClone(opts.importSources ?? MOCK_IMPORT_SOURCES)),
    themeImportFile: () => Promise.resolve(structuredClone(MOCK_IMPORT_FILE)),
    fontsList: () => Promise.resolve(structuredClone(MOCK_SYSTEM_FONTS)),
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
