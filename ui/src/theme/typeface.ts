/**
 * Fonts per area (Settings > Themes > Fonts). Five areas take a family and a size. An unset
 * area inherits: chat and sidebar from UI, status bar from code for the family and from UI for
 * the size, code from the base's mono. A section or a session can override the chat font.
 *
 * Everything reaches CSS as variables on the `.pr-app` root, never as per-component literals:
 * `--f-ui`, `--f-mono`, `--f-chat`, `--f-side`, `--f-strip` for families and `--fz-ui`,
 * `--fz-chat`, `--fz-side`, `--fz-strip`, `--fz-code` as size scales (chosen / default).
 * `base.css` and `styles.css` route each area through them.
 */
import type { BaseId } from './types.ts';

export type FontArea = 'ui' | 'chat' | 'code' | 'sidebar' | 'statusBar';

export interface FontChoice {
  family?: string;
  size?: number;
}

export interface FontPrefs {
  ui?: FontChoice;
  chat?: FontChoice;
  code?: FontChoice;
  sidebar?: FontChoice;
  statusBar?: FontChoice;
  perSection?: Record<string, FontChoice>;
  perSession?: Record<string, FontChoice>;
}

export interface AreaInfo {
  id: FontArea;
  label: string;
  /** What it styles, for the row's description and for search. */
  description: string;
  /** Only fixed-pitch families. */
  mono: boolean;
  /** The size the base draws at, in px. The scale variable is chosen / this. */
  defaultSize: number;
  sizes: readonly number[];
}

const SANS_SIZES = [11, 12, 13, 14, 15, 16, 17, 18] as const;

export const FONT_AREAS: readonly AreaInfo[] = [
  {
    id: 'ui',
    label: 'UI',
    description: 'The default for everything.',
    mono: false,
    defaultSize: 13,
    sizes: SANS_SIZES,
  },
  {
    id: 'chat',
    label: 'Chat messages',
    description: 'Messages and threads.',
    mono: false,
    defaultSize: 13,
    sizes: SANS_SIZES,
  },
  {
    id: 'code',
    label: 'Code and terminal',
    description: 'Code blocks, diffs and the terminal. Fixed-pitch fonts only.',
    mono: true,
    defaultSize: 13,
    sizes: [10, 11, 12, 13, 14, 15, 16, 18, 20],
  },
  {
    id: 'sidebar',
    label: 'Sidebar',
    description: 'Sections and sessions.',
    mono: false,
    defaultSize: 13,
    sizes: SANS_SIZES,
  },
  {
    id: 'statusBar',
    label: 'Status bar',
    description: 'The strip under the composer.',
    mono: false,
    defaultSize: 11,
    sizes: [9, 10, 11, 12, 13, 14],
  },
];

export const areaInfo = (id: FontArea): AreaInfo => FONT_AREAS.find((a) => a.id === id)!;

/** One family the picker offers. */
export interface FontOption {
  family: string;
  mono: boolean;
  /** Ships inside Patchroom (OFL, `fonts.css`), so it looks the same on every Mac. */
  bundled?: boolean;
}

/** The faces `fonts.css` declares. */
export const BUNDLED_FONTS: readonly FontOption[] = [
  { family: 'Figtree', mono: false, bundled: true },
  { family: 'Barlow', mono: false, bundled: true },
  { family: 'Barlow Condensed', mono: false, bundled: true },
  { family: 'JetBrains Mono', mono: true, bundled: true },
  { family: 'Red Hat Mono', mono: true, bundled: true },
];

/** The first family of each base's `--f-ui` and `--f-mono` (`bases/<id>.css`). */
const BASE_FACES: Record<BaseId, { ui: string; mono: string }> = {
  homeroom: { ui: 'Figtree', mono: 'JetBrains Mono' },
  patchbay: { ui: 'Barlow', mono: 'Red Hat Mono' },
  scrollback: { ui: 'Spline Sans', mono: 'Spline Sans Mono' },
  bluepencil: { ui: 'Hanken Grotesk', mono: 'Fragment Mono' },
};

/** The terminal's own default, which predates fonts per area. */
export const TERMINAL_DEFAULT_FONT = 'JetBrains Mono';

/** Same rule as the backend (`patchroom-prefs` fonts): a plain name that is safe in CSS. */
export function validFamily(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.trim() === name &&
    [...name].length <= 96 &&
    // eslint-disable-next-line no-control-regex
    !/["'\\;{}<>\u0000-\u001f\u007f]/.test(name)
  );
}

const validSize = (s: unknown): s is number =>
  typeof s === 'number' && Number.isFinite(s) && s >= 8 && s <= 32;

function cleanChoice(raw: unknown): FontChoice | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: FontChoice = {};
  if (validFamily(r.family)) out.family = r.family;
  if (validSize(r.size)) out.size = r.size;
  return out.family || out.size ? out : undefined;
}

function cleanMap(raw: unknown): Record<string, FontChoice> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, FontChoice> = {};
  for (const [k, v] of Object.entries(raw)) {
    const c = cleanChoice(v);
    if (c && k) out[k] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Stored or patched fonts with anything unusable dropped. */
export function cleanFonts(raw: unknown): FontPrefs {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: FontPrefs = {};
  for (const a of FONT_AREAS) {
    const c = cleanChoice(r[a.id]);
    if (c) out[a.id] = c;
  }
  const ps = cleanMap(r.perSection);
  if (ps) out.perSection = ps;
  const pd = cleanMap(r.perSession);
  if (pd) out.perSession = pd;
  return out;
}

/** Set one area's field. `undefined` clears it; an empty area disappears. */
export function setArea(fonts: FontPrefs, area: FontArea, patch: FontChoice): FontPrefs {
  const next: FontChoice = { ...fonts[area], ...patch };
  if (next.family === undefined) delete next.family;
  if (next.size === undefined) delete next.size;
  const out = { ...fonts };
  if (next.family || next.size) out[area] = next;
  else delete out[area];
  return out;
}

/** Set (or with an empty choice, clear) a section's or session's chat font. */
export function setOverride(
  fonts: FontPrefs,
  kind: 'perSection' | 'perSession',
  id: string,
  choice: FontChoice,
): FontPrefs {
  const map = { ...(fonts[kind] ?? {}) };
  const c = cleanChoice(choice);
  if (c) map[id] = c;
  else delete map[id];
  const out = { ...fonts };
  if (Object.keys(map).length) out[kind] = map;
  else delete out[kind];
  return out;
}

/** What an area shows when it has no value of its own: the family and size, and from where. */
export interface Effective {
  family: string;
  size: number;
  /** Where an unset family comes from: `default` (the base), or another area. */
  familyFrom: FontArea | 'default' | 'own';
  sizeFrom: FontArea | 'default' | 'own';
}

/** The family and size an area draws in, and where each comes from. */
export function effectiveFont(fonts: FontPrefs, area: FontArea, base: BaseId): Effective {
  const faces = BASE_FACES[base] ?? BASE_FACES.homeroom;
  const own = fonts[area] ?? {};
  const info = areaInfo(area);
  const uiScale = (fonts.ui?.size ?? 13) / 13;
  const famParent: FontArea | null =
    area === 'chat' || area === 'sidebar' ? 'ui' : area === 'statusBar' ? 'code' : null;
  const sizeParent: FontArea | null = area === 'code' || area === 'ui' ? null : 'ui';
  let family: string;
  let familyFrom: Effective['familyFrom'];
  if (own.family) {
    family = own.family;
    familyFrom = 'own';
  } else if (famParent) {
    const p = effectiveFont(fonts, famParent, base);
    family = p.family;
    familyFrom = famParent;
  } else {
    family = area === 'code' ? faces.mono : faces.ui;
    familyFrom = 'default';
  }
  let size: number;
  let sizeFrom: Effective['sizeFrom'];
  if (own.size) {
    size = own.size;
    sizeFrom = 'own';
  } else if (sizeParent && fonts.ui?.size) {
    size = Math.round(info.defaultSize * uiScale * 2) / 2;
    sizeFrom = sizeParent;
  } else {
    size = info.defaultSize;
    sizeFrom = 'default';
  }
  return { family, size, familyFrom, sizeFrom };
}

/** A CSS stack for a chosen family, with the generic fallbacks of its kind. */
export function familyStack(family: string, mono: boolean): string {
  return mono
    ? `"${family}", ui-monospace, Menlo, monospace`
    : `"${family}", ui-sans-serif, system-ui, -apple-system, sans-serif`;
}

const scale = (size: number, def: number) => String(Math.round((size / def) * 1000) / 1000);

/**
 * CSS variables for the `.pr-app` root. Only areas with a value appear, so an unset area keeps
 * the CSS default (which inherits from its parent area).
 */
export function fontVars(fonts: FontPrefs | undefined): Record<string, string> {
  const f = fonts ?? {};
  const out: Record<string, string> = {};
  if (f.ui?.family) out['--f-ui'] = familyStack(f.ui.family, false);
  if (f.code?.family) out['--f-mono'] = familyStack(f.code.family, true);
  if (f.chat?.family) out['--f-chat'] = familyStack(f.chat.family, false);
  if (f.sidebar?.family) out['--f-side'] = familyStack(f.sidebar.family, false);
  if (f.statusBar?.family) out['--f-strip'] = familyStack(f.statusBar.family, false);
  if (f.ui?.size) out['--fz-ui'] = scale(f.ui.size, 13);
  if (f.chat?.size) out['--fz-chat'] = scale(f.chat.size, 13);
  if (f.sidebar?.size) out['--fz-side'] = scale(f.sidebar.size, 13);
  if (f.statusBar?.size) out['--fz-strip'] = scale(f.statusBar.size, 11);
  if (f.code?.size) out['--fz-code'] = scale(f.code.size, 13);
  return out;
}

/** The chat font a section or a session overrides, the session's first. */
export function chatOverride(
  fonts: FontPrefs | undefined,
  sessionId: string | null | undefined,
  sectionId: string | null | undefined,
): FontChoice | null {
  const s = sessionId ? fonts?.perSession?.[sessionId] : undefined;
  const c = sectionId ? fonts?.perSection?.[sectionId] : undefined;
  if (!s && !c) return null;
  return { family: s?.family ?? c?.family, size: s?.size ?? c?.size };
}

/** Variables for one chat view, from its override. Empty when it has none. */
export function chatOverrideVars(o: FontChoice | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (o?.family) out['--f-chat'] = familyStack(o.family, false);
  if (o?.size) out['--fz-chat'] = scale(o.size, 13);
  return out;
}

// ---- installed families --------------------------------------------------------------------

type Lister = () => Promise<FontOption[]>;
let lister: Lister | null = null;
let cached: Promise<FontOption[]> | null = null;

/** Where installed families come from: `fonts_list` in the app, a fixture in the browser. */
export function setFontLister(fn: Lister | null): void {
  lister = fn;
  cached = null;
}

/** Bundled faces first, then installed families (once per run). Never rejects. */
export function listFonts(): Promise<FontOption[]> {
  cached ??= (lister ? lister().catch(() => [] as FontOption[]) : Promise.resolve([])).then(
    (sys) => {
      const seen = new Set(BUNDLED_FONTS.map((f) => f.family.toLowerCase()));
      const rest = sys.filter((f) => validFamily(f.family) && !seen.has(f.family.toLowerCase()));
      return [...BUNDLED_FONTS, ...rest];
    },
  );
  return cached;
}

/** A fixed list the mock backend returns, so tests and the browser build see system fonts. */
export const MOCK_SYSTEM_FONTS: FontOption[] = [
  { family: 'Avenir Next', mono: false },
  { family: 'Georgia', mono: false },
  { family: 'Helvetica Neue', mono: false },
  { family: 'Menlo', mono: true },
  { family: 'Monaco', mono: true },
  { family: 'SF Mono', mono: true },
  { family: 'Times New Roman', mono: false },
  { family: 'Verdana', mono: false },
];
