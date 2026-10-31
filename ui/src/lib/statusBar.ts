import type { Prefs, StatusChips, StatusModuleId } from '../ipc';
import { parseAnsi } from './ansi';
import { cwdParts } from './cwd';

/** One status strip module: a chip built from the CLI's facts, or the user's own statusLine. */
export interface ModuleDef {
  id: StatusModuleId;
  label: string;
  hint: string;
}

/** Built-in order. The user's statusLine comes last, as its own block under the chips. */
export const MODULES: ModuleDef[] = [
  { id: 'model', label: 'Model', hint: 'The model in use' },
  { id: 'folder', label: 'Folder', hint: 'The working folder' },
  { id: 'worktree', label: 'Worktree', hint: 'The git worktree' },
  { id: 'context', label: 'Context', hint: 'Context window used' },
  { id: 'cost', label: 'Cost', hint: 'Spend so far' },
  { id: 'mode', label: 'Mode', hint: 'Permission mode. Click it to cycle.' },
  { id: 'branch', label: 'Branch', hint: 'The git branch' },
  { id: 'pr', label: 'Pull request', hint: 'The open pull request' },
  { id: 'statusline', label: 'Your statusLine', hint: 'The output of your own statusLine command' },
];

export const MODULE_IDS: StatusModuleId[] = MODULES.map((m) => m.id);

/** One option of a built-in module. The first choice is the default. Built-ins only: no scripts. */
export interface ModuleOption {
  key: string;
  label: string;
  choices: readonly { value: string; label: string }[];
}

/** Every module option. The backend accepts exactly these pairs (`MODULE_OPTIONS` in prefs). */
export const MODULE_OPTIONS: Partial<Record<StatusModuleId, readonly ModuleOption[]>> = {
  folder: [
    {
      key: 'show',
      label: 'Show',
      choices: [
        { value: 'name', label: 'Folder name' },
        { value: 'path', label: 'Full path' },
      ],
    },
  ],
  context: [
    {
      key: 'show',
      label: 'Show',
      choices: [
        { value: 'meter', label: 'Meter and percent' },
        { value: 'percent', label: 'Percent only' },
      ],
    },
  ],
  cost: [
    {
      key: 'decimals',
      label: 'Round to',
      choices: [
        { value: '2', label: 'Cents' },
        { value: '0', label: 'Whole dollars' },
      ],
    },
  ],
};

/** A module's option value: the saved one when it is known, else the default. */
export function moduleOption(
  prefs: Pick<Prefs, 'statusBar'> | null | undefined,
  id: StatusModuleId,
  key: string,
): string {
  const opt = MODULE_OPTIONS[id]?.find((o) => o.key === key);
  const saved = prefs?.statusBar?.options?.[id]?.[key];
  if (opt && saved && opt.choices.some((c) => c.value === saved)) return saved;
  return opt?.choices[0].value ?? '';
}

/**
 * Where "Suggest a module" goes: a new issue on the public repo from the status-bar-module
 * form. A plain URL with no identifiers. Patchroom opens it only when the person clicks.
 */
export const SUGGEST_MODULE_URL =
  'https://github.com/noahp-info/patchroom/issues/new?template=status-bar-module.yml';
const KNOWN = new Set<string>(MODULE_IDS);

export const moduleLabel = (id: string): string => MODULES.find((m) => m.id === id)?.label ?? id;

export function prLabel(url: string): string {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `PR #${m[1]}` : 'PR';
}

/** The CLI's mode ids are camelCase (`acceptEdits`); show words. */
export function modeText(m: string): string {
  return m.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

export function costText(c: number | string, decimals = 2): string {
  if (typeof c === 'number') return `$${c.toFixed(decimals)}`;
  return c.startsWith('$') ? c : `$${c}`;
}

export function contextPct(chips: StatusChips): number | undefined {
  return chips.contextPct === undefined
    ? undefined
    : Math.max(0, Math.min(100, Math.round(chips.contextPct)));
}

/** The statusLine as plain text: escapes gone, lowercase, for fact matching. */
export function plainStatusText(ansi: string | undefined): string {
  if (!ansi) return '';
  return parseAnsi(ansi)
    .map((spans) => spans.map((s) => s.text).join(''))
    .join('\n')
    .toLowerCase();
}

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `needle` appears in `hay` as its own token, not inside a longer name. */
function hasToken(hay: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  return new RegExp(`(?<![\\w./-])${escapeRx(n)}(?![\\w-])`).test(hay);
}

export interface StatusFacts {
  chips: StatusChips;
  cwd: string;
  /** The user's statusLine output (ANSI). */
  statusText?: string;
}

/**
 * Chip modules whose fact the user's own statusLine already prints. Whole facts only: the model
 * name, the folder name, "64%", "$1.82", the mode words, "#14". A partial overlap is not a
 * duplicate, so a statusLine that prints "patchroom" does not hide the "patchroom-test" folder.
 */
export function duplicateModules(f: StatusFacts): Set<StatusModuleId> {
  const out = new Set<StatusModuleId>();
  const text = plainStatusText(f.statusText);
  if (!text) return out;
  const { chips } = f;
  if (chips.model && hasToken(text, chips.model)) out.add('model');
  const base = cwdParts(f.cwd).base;
  if (base && hasToken(text, base)) out.add('folder');
  if (chips.worktree && text.includes(chips.worktree.toLowerCase())) out.add('worktree');
  if (chips.branch && hasToken(text, chips.branch)) out.add('branch');
  const pct = contextPct(chips);
  if (pct !== undefined && new RegExp(`(?<!\\d)${pct}\\s?%`).test(text)) out.add('context');
  if (chips.cost !== undefined) {
    const shown = costText(chips.cost).toLowerCase();
    if (text.includes(shown) || (shown.startsWith('$') && hasToken(text, shown.slice(1)))) {
      out.add('cost');
    }
  }
  if (chips.mode) {
    const words = modeText(chips.mode);
    if (hasToken(text, words) || hasToken(text, chips.mode)) out.add('mode');
  }
  if (chips.prUrl) {
    const n = /\/pull\/(\d+)/.exec(chips.prUrl)?.[1];
    if (text.includes(chips.prUrl.toLowerCase()) || (n && new RegExp(`#${n}(?!\\d)`).test(text))) {
      out.add('pr');
    }
  }
  return out;
}

/** Modules that have something to show right now. */
export function availableModules(f: StatusFacts): Set<StatusModuleId> {
  const out = new Set<StatusModuleId>(['folder']);
  const { chips } = f;
  if (chips.model) out.add('model');
  if (chips.worktree) out.add('worktree');
  if (chips.branch) out.add('branch');
  if (contextPct(chips) !== undefined) out.add('context');
  if (chips.cost !== undefined) out.add('cost');
  if (chips.mode) out.add('mode');
  if (chips.prUrl) out.add('pr');
  if (plainStatusText(f.statusText).trim() !== '') out.add('statusline');
  return out;
}

export type LayoutSource = 'dm' | 'default' | 'builtin';

export interface Layout {
  /** Enabled modules in display order, whether or not they have data right now. */
  active: StatusModuleId[];
  /** Removed modules, in built-in order. `duplicate` marks ones the built-in layout hid. */
  tray: { id: StatusModuleId; duplicate: boolean }[];
  /** Which setting decided: this DM's override, the global default, or the built-in layout. */
  source: LayoutSource;
}

const clean = (ids: readonly string[]): StatusModuleId[] => {
  const seen = new Set<string>();
  const out: StatusModuleId[] = [];
  for (const id of ids) {
    if (KNOWN.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id as StatusModuleId);
    }
  }
  return out;
};

/**
 * The layout for one DM. A per-DM list wins over the global one. With neither, the built-in
 * layout applies: every module, minus chips that repeat the user's statusLine. A saved list is
 * taken as written, so a module the user added back stays even when it repeats.
 */
export function resolveLayout(
  prefs: Pick<Prefs, 'statusBar'> | null | undefined,
  dmId: string,
  facts: StatusFacts,
): Layout {
  const sb = prefs?.statusBar;
  const own = sb?.perDm?.[dmId];
  const global = sb?.default;
  const dups = duplicateModules(facts);
  let active: StatusModuleId[];
  let source: LayoutSource;
  if (own) {
    active = clean(own);
    source = 'dm';
  } else if (global) {
    active = clean(global);
    source = 'default';
  } else {
    active = MODULE_IDS.filter((id) => !dups.has(id));
    source = 'builtin';
  }
  const on = new Set(active);
  const tray = MODULE_IDS.filter((id) => !on.has(id)).map((id) => ({
    id,
    duplicate: dups.has(id),
  }));
  return { active, tray, source };
}

/** What renders: the layout's modules that have data now. */
export function visibleModules(layout: Layout, facts: StatusFacts): StatusModuleId[] {
  const have = availableModules(facts);
  return layout.active.filter((id) => have.has(id));
}

/** Move `id` before `beforeId` (or to the end when null). */
export function moveModule(
  list: readonly StatusModuleId[],
  id: StatusModuleId,
  beforeId: StatusModuleId | null,
): StatusModuleId[] {
  const rest = list.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  rest.splice(at < 0 ? rest.length : at, 0, id);
  return rest;
}
