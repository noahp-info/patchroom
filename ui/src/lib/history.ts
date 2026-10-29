import type { HistoryGroup, HistorySession, ModelCatalog } from '../ipc';
import { findModel } from './models/catalog';
import { toMillis } from './time';

/** The groupings the History header toggles between, in toggle order. */
export const HISTORY_GROUPS: readonly { id: HistoryGroup; label: string }[] = [
  { id: 'folder', label: 'Folder' },
  { id: 'date', label: 'Date' },
  { id: 'model', label: 'Model' },
  { id: 'branch', label: 'Branch' },
];

export interface HistoryBucket {
  /** Stable key within one grouping. */
  key: string;
  label: string;
  /** Muted second line of the header (a folder's parent path). */
  detail?: string;
  sessions: HistorySession[];
  /** Newest activity in the bucket, for ordering. */
  newest: number;
}

const DAY = 86_400_000;

/** Monday 00:00 local of the week holding `ms`. */
function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** ISO 8601 week number of `ms`. */
export function isoWeek(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - jan4.getTime()) / DAY - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

/**
 * The date bucket of `ms`: Today, This week, then the four weeks before by week number, then
 * by month (with the year when it is not this year).
 */
export function dateBucket(ms: number, now = Date.now()): { key: string; label: string } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) return { key: 'today', label: 'Today' };
  const thisWeek = weekStart(now);
  if (ms >= thisWeek) return { key: 'week', label: 'This week' };
  const ws = weekStart(ms);
  if (ws >= thisWeek - 4 * 7 * DAY) {
    return { key: `w${ws}`, label: `Week ${isoWeek(ms)}` };
  }
  const d = new Date(ms);
  const sameYear = d.getFullYear() === today.getFullYear();
  const label = d.toLocaleString(
    'en-US',
    sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' },
  );
  return { key: `m${d.getFullYear()}-${d.getMonth()}`, label };
}

/** Last path segment, and the path before it. */
export function folderParts(path: string): { name: string; parent: string } {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop() ?? path;
  return { name, parent: parts.length ? `/${parts.join('/')}` : '' };
}

/** A model id as people say it: the catalog name, else the id. */
export function modelDisplay(catalog: ModelCatalog, id: string | null | undefined): string {
  if (!id) return 'Unknown model';
  return findModel(catalog, id)?.name ?? id;
}

/**
 * Rows that match every word of `query` in their title, first prompt, folder, branch or model.
 * Words match anywhere in a word, case-insensitively.
 */
export function filterHistory(
  rows: readonly HistorySession[],
  query: string,
  catalog: ModelCatalog,
): HistorySession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((r) => {
    const hay = [
      r.title,
      r.firstPrompt,
      r.folder,
      r.branch ?? '',
      r.model ?? '',
      modelDisplay(catalog, r.model),
    ]
      .join('\n')
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Group rows (already newest first) by `by`. Buckets come newest first. */
export function groupHistory(
  rows: readonly HistorySession[],
  by: HistoryGroup,
  catalog: ModelCatalog,
  now = Date.now(),
): HistoryBucket[] {
  const map = new Map<string, HistoryBucket>();
  for (const r of rows) {
    const t = toMillis(r.lastActivity);
    let key: string;
    let label: string;
    let detail: string | undefined;
    if (by === 'folder') {
      const p = folderParts(r.folder);
      key = r.folder;
      label = p.name;
      detail = p.parent;
    } else if (by === 'date') {
      ({ key, label } = dateBucket(t, now));
    } else if (by === 'model') {
      key = r.model ?? '';
      label = modelDisplay(catalog, r.model);
    } else {
      key = r.branch ?? '';
      label = r.branch || 'No branch recorded';
    }
    let b = map.get(key);
    if (!b) {
      b = { key, label, detail, sessions: [], newest: t };
      map.set(key, b);
    }
    b.sessions.push(r);
    b.newest = Math.max(b.newest, t);
  }
  return [...map.values()].sort((a, b) => b.newest - a.newest || a.label.localeCompare(b.label));
}
