import type {
  BundleEntry,
  ModelBundle,
  ModelCatalog,
  ModelPlace,
  ModelPrefs,
  Prefs,
  StatusChips,
} from '../../ipc';
import { adapterOf } from './adapters';
import { findModel, resolveModel } from './catalog';

export const EMPTY_MODELS: ModelPrefs = {
  bundles: [],
  defaultBundle: null,
  perFolder: {},
  perSection: {},
  perSession: {},
  labels: {},
  groupLabels: { cloud: '☁️ {name}', local: '\u{1F3E0} {name}' },
  seen: [],
  offered: [],
};

export function modelsOf(prefs: Pick<Prefs, 'models'> | null | undefined): ModelPrefs {
  const m = prefs?.models;
  return m
    ? { ...EMPTY_MODELS, ...m, groupLabels: { ...EMPTY_MODELS.groupLabels, ...m.groupLabels } }
    : EMPTY_MODELS;
}

/** Where a session sits, for picking its bundle. */
export interface BundleScope {
  sessionId?: string | null;
  sectionId?: string | null;
  cwd?: string | null;
}

export type BundleSource = 'session' | 'section' | 'folder' | 'default';

/**
 * The bundle that applies: the session's own, then its section's, then the deepest folder that
 * holds its cwd, then the global default. Undefined when the user has none.
 */
export function activeBundle(
  models: ModelPrefs,
  scope: BundleScope,
): { bundle: ModelBundle; source: BundleSource } | undefined {
  const byId = (id: string | null | undefined) =>
    id ? models.bundles.find((b) => b.id === id) : undefined;
  const pick = (id: string | null | undefined, source: BundleSource) => {
    const bundle = byId(id);
    return bundle ? { bundle, source } : undefined;
  };
  const folder = scope.cwd
    ? Object.keys(models.perFolder)
        .filter((f) => scope.cwd === f || scope.cwd!.startsWith(`${f.replace(/\/+$/, '')}/`))
        .sort((a, b) => b.length - a.length)[0]
    : undefined;
  return (
    pick(scope.sessionId ? models.perSession[scope.sessionId] : null, 'session') ??
    pick(scope.sectionId ? models.perSection[scope.sectionId] : null, 'section') ??
    pick(folder ? models.perFolder[folder] : null, 'folder') ??
    pick(models.defaultBundle, 'default')
  );
}

export const defaultEntry = (b: ModelBundle): BundleEntry | undefined =>
  b.entries.find((e) => e.id === b.defaultEntry) ?? b.entries[0];

/** The launch arguments for a new session in `scope`: the bundle default through its adapter. */
export function launchArgsFor(
  prefs: Pick<Prefs, 'models'> | null | undefined,
  catalog: ModelCatalog,
  scope: BundleScope,
): string[] | undefined {
  const found = activeBundle(modelsOf(prefs), scope);
  const entry = found && defaultEntry(found.bundle);
  if (!entry) return undefined;
  const model = resolveModel(catalog, entry.tool, entry.model);
  return adapterOf(entry.tool)?.launchArgs(model) ?? undefined;
}

/** A short random id for a bundle or entry. */
export function newId(prefix: string): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${r}`;
}

// ---- labels ------------------------------------------------------------------------------------

/** Cloud or local: the user's switch, then the session's API base, then the catalog. */
export function placeOf(
  models: ModelPrefs,
  catalog: ModelCatalog,
  modelId: string | undefined,
  chips?: StatusChips,
): ModelPlace {
  const own = modelId ? models.labels[modelId]?.place : undefined;
  if (own) return own;
  if (chips?.apiLocal) return 'local';
  return findModel(catalog, modelId)?.where === 'local' ? 'local' : 'cloud';
}

/**
 * What the model chip says: the model's own label, then the Cloud or Local template, then the
 * plain name. Keyed by model id, so a label follows the model across `/model` switches.
 */
export function modelLabel(
  models: ModelPrefs,
  catalog: ModelCatalog,
  chips: StatusChips | undefined,
): { text: string; own: boolean; place: ModelPlace } {
  const id = chips?.modelId;
  const name = chips?.model ?? findModel(catalog, id)?.name ?? id ?? '';
  const place = placeOf(models, catalog, id, chips);
  const own = id ? models.labels[id] : undefined;
  if (own?.text || own?.emoji) {
    return { text: [own.emoji, own.text || name].filter(Boolean).join(' '), own: true, place };
  }
  const tpl = models.groupLabels[place];
  if (tpl && tpl.includes('{name}'))
    return { text: tpl.replace('{name}', name), own: false, place };
  if (tpl) return { text: `${tpl} ${name}`.trim(), own: false, place };
  return { text: name, own: false, place };
}
