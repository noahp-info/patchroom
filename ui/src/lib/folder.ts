import type { FolderSession, SessionInfo } from '../ipc';
import { toMillis } from './time';

/** Default for `SectionInfo.archiveDays` when the backend omits it. */
export const DEFAULT_ARCHIVE_DAYS = 14;

/** Compact age: "now", "5m", "3h", "2d", "3w", "4mo", "2y". */
export function relativeAge(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round(d / 365)}y`;
}

/** Longer form for tooltips and screen readers: "3 hours ago". */
export function relativeAgeLong(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const short = relativeAge(ms, now);
  if (short === 'now') return 'just now';
  const n = parseInt(short, 10);
  const unit = short.replace(String(n), '');
  const word =
    { m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' }[unit] ?? unit;
  return `${n} ${word}${n === 1 ? '' : 's'} ago`;
}

/** Where a name came from, for the hover card. */
export const NAME_SOURCE_LABEL: Record<string, string> = {
  user: 'Named in Patchroom',
  registry: 'From the session-naming registry',
  'custom-title': 'From /rename',
  'ai-title': 'Title written by Claude',
  prompt: 'First prompt',
};

/** One line of the section body: an open DM, or a session that is only a row so far. */
export type FolderEntry =
  | { kind: 'dm'; session: SessionInfo; info: FolderSession | null; at: number; rank: number }
  | { kind: 'lazy'; info: FolderSession; at: number; rank: number };

export interface FolderLayout {
  /** Rows shown in the main list, in order. */
  main: FolderEntry[];
  /** Rows folded into "Older than X days". */
  older: FolderEntry[];
}

/**
 * Order a folder section. Open DMs that need you come first, then busy ones. The rest follow by
 * last activity, newest first. Lazy rows with no activity in `archiveDays` fold into `older`.
 * Hidden rows appear only when `showHidden`.
 */
export function layoutFolder(args: {
  dms: SessionInfo[];
  /** Every DM id that exists (also starred and archived ones), so none shows twice. */
  openIds: Set<string>;
  sessions: FolderSession[];
  needs: (s: SessionInfo) => boolean;
  archiveDays: number;
  showHidden: boolean;
  now?: number;
}): FolderLayout {
  const now = args.now ?? Date.now();
  const byDm = new Map(args.sessions.flatMap((f) => (f.dmId ? [[f.dmId, f] as const] : [])));
  const entries: FolderEntry[] = [];
  for (const s of args.dms) {
    const info = byDm.get(s.id) ?? null;
    // A DM with no transcript entry yet is brand new: it sorts as active now.
    const at = info ? toMillis(info.lastActivity) : now;
    const rank = args.needs(s) ? 0 : s.status === 'busy' ? 1 : 2;
    entries.push({ kind: 'dm', session: s, info, at, rank });
  }
  for (const f of args.sessions) {
    if (f.dmId && args.openIds.has(f.dmId)) continue;
    if (f.hidden && !args.showHidden) continue;
    entries.push({ kind: 'lazy', info: f, at: toMillis(f.lastActivity), rank: 2 });
  }
  entries.sort((a, b) => a.rank - b.rank || b.at - a.at);
  const cutoff = now - args.archiveDays * 86_400_000;
  const main: FolderEntry[] = [];
  const older: FolderEntry[] = [];
  for (const e of entries) (e.kind === 'lazy' && e.at < cutoff ? older : main).push(e);
  return { main, older };
}

/** Distinct launch folders under a section's home, for the New DM dialog's worktree switch. */
export function launchFolders(home: string, sessions: FolderSession[]): string[] {
  const set = new Set<string>([home]);
  for (const f of sessions) if (f.launchCwd) set.add(f.launchCwd);
  // Home first, then folders under it, then linked worktrees elsewhere.
  const group = (f: string) => (f === home ? 0 : f.startsWith(`${home}/`) ? 1 : 2);
  return [...set].sort((a, b) => group(a) - group(b) || a.localeCompare(b));
}
