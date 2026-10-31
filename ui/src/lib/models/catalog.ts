import type { CatalogModel, ModelCatalog } from '../../ipc';
import shipped from './catalog.json';

/**
 * The model catalog: the one this build ships (refreshed weekly by CI), merged with a newer
 * signed one the backend fetched when the user opted in. Nothing here touches the network.
 */
export const SHIPPED_CATALOG = shipped as ModelCatalog;

/** `latest:<family>` follows the newest model of that family in the catalog. */
export const LATEST_PREFIX = 'latest:';

export const isLatest = (model: string): boolean => model.startsWith(LATEST_PREFIX);
export const latestFamily = (model: string): string => model.slice(LATEST_PREFIX.length);

const key = (m: Pick<CatalogModel, 'tool' | 'id'>) => `${m.tool}\u0000${m.id}`;

/** Both catalogs, union by tool and id. A fetched entry replaces a shipped one. */
export function mergeCatalogs(base: ModelCatalog, extra: ModelCatalog | null): ModelCatalog {
  if (!extra) return base;
  const byKey = new Map(base.models.map((m) => [key(m), m]));
  for (const m of extra.models) byKey.set(key(m), m);
  const tools = new Map(base.tools.map((t) => [t.id, t]));
  for (const t of extra.tools ?? []) tools.set(t.id, t);
  return {
    schema: 1,
    generated: extra.generated > base.generated ? extra.generated : base.generated,
    tools: [...tools.values()],
    models: [...byKey.values()],
  };
}

/** Compare dotted versions: positive when `a` is newer. Missing parts count as 0. */
export function compareVersions(a = '0', b = '0'): number {
  const x = a.split('.').map((n) => Number(n) || 0);
  const y = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const newer = (a: CatalogModel, b: CatalogModel): number =>
  compareVersions(a.version, b.version) || (a.released ?? '').localeCompare(b.released ?? '');

/** The model a CLI reports, matched loosely: `claude-opus-4-8[1m]` and dated ids find their base. */
export function findModel(
  catalog: ModelCatalog,
  id: string | undefined,
  tool?: string,
): CatalogModel | undefined {
  if (!id) return undefined;
  const base = id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  const pool = tool ? catalog.models.filter((m) => m.tool === tool) : catalog.models;
  return pool.find((m) => m.id === id) ?? pool.find((m) => m.id === base);
}

/** The newest model of one family for one tool. */
export function newestInFamily(
  catalog: ModelCatalog,
  tool: string,
  family: string,
): CatalogModel | undefined {
  return catalog.models
    .filter((m) => m.tool === tool && m.family === family)
    .sort((a, b) => newer(b, a))[0];
}

/** A newer model in the same family as `id`, or undefined when `id` is the newest (or unknown). */
export function newerThan(
  catalog: ModelCatalog,
  id: string,
  tool: string,
): CatalogModel | undefined {
  const cur = findModel(catalog, id, tool);
  if (!cur) return undefined;
  const top = newestInFamily(catalog, tool, cur.family);
  return top && top.id !== cur.id && newer(top, cur) > 0 ? top : undefined;
}

/** Families of one tool, newest model first, for the "latest <family>" choices. */
export function families(catalog: ModelCatalog, tool: string): CatalogModel[] {
  const seen = new Map<string, CatalogModel>();
  for (const m of catalog.models) {
    if (m.tool !== tool) continue;
    const have = seen.get(m.family);
    if (!have || newer(m, have) > 0) seen.set(m.family, m);
  }
  return [...seen.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** The concrete model id an entry launches: `latest:<family>` resolves through the catalog. */
export function resolveModel(catalog: ModelCatalog, tool: string, model: string): string {
  if (!isLatest(model)) return model;
  return newestInFamily(catalog, tool, latestFamily(model))?.id ?? latestFamily(model);
}

/** What to call a model in lists: the catalog name, else the string itself. */
export function modelName(catalog: ModelCatalog, model: string, tool?: string): string {
  if (isLatest(model)) {
    const fam = latestFamily(model);
    return `Latest ${fam.charAt(0).toUpperCase()}${fam.slice(1)}`;
  }
  const found = findModel(catalog, model, tool);
  if (!found) return model;
  // A variant of a known model (`claude-opus-4-8[1m]`) keeps its suffix, so the two stay apart.
  return found.id === model ? found.name : `${found.name} ${model.slice(found.id.length)}`.trim();
}
