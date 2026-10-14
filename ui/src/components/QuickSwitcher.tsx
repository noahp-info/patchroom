import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FolderSession, SessionInfo, SessionStatus } from '../ipc';
import { relativeAge } from '../lib/folder';
import { toMillis } from '../lib/time';
import { fuzzy } from '../lib/fuzzy';
import { cwdParts } from '../lib/cwd';
import type { AppState, AppStore } from '../state/store';
import { ClaudeGlyph } from './Icon';

/** A folder-section session that is not a DM yet. Opening it resumes it. */
export interface LazyHit {
  sectionId: string;
  sectionName: string;
  info: FolderSession;
}

export interface Ranked {
  /** Set for an open DM. */
  session?: SessionInfo;
  /** Set for a session found in a folder section but not opened. */
  lazy?: LazyHit;
  /** Stable option id. */
  key: string;
  needs: boolean;
  unread: number;
  /** Matched offsets in the DM name. */
  at: number[];
  score: number;
}

const PRESENCE: Record<SessionStatus, string> = {
  busy: 'busy',
  idle: 'idle',
  waiting: 'needs',
  exited: 'idle',
};

/**
 * Match `query` against each DM's name, folder and path. Needs-you DMs and recently opened ones
 * come first; with an empty query that is the whole order. Archived DMs sort last.
 */
export function rankDms(
  state: Pick<AppState, 'sessions' | 'badges' | 'recent'> &
    Partial<Pick<AppState, 'sections' | 'folders'>>,
  query: string,
): Ranked[] {
  const out: Ranked[] = [];
  for (const s of state.sessions) {
    const b = state.badges[s.id];
    const needs = s.status === 'waiting' || (b?.needsYou ?? 0) > 0;
    const unread = b?.unread ?? 0;
    const r = state.recent.indexOf(s.id);
    const boost =
      (needs ? 60 : 0) +
      (r >= 0 ? Math.max(0, 48 - r * 6) : 0) +
      (unread > 0 ? 8 : 0) -
      (s.archived ? 400 : 0);
    let score = boost;
    let at: number[] = [];
    if (query.trim() !== '') {
      const byName = fuzzy(query, s.name);
      const byFolder = fuzzy(query, cwdParts(s.cwd).base);
      const byPath = fuzzy(query, s.cwd);
      const best = Math.max(
        byName ? byName.score * 1.5 : -1,
        byFolder ? byFolder.score : -1,
        byPath ? byPath.score * 0.5 : -1,
      );
      if (best < 0) continue;
      score += best;
      at = byName?.at ?? [];
    }
    out.push({ key: s.id, session: s, needs, unread, at, score });
  }
  // Folder sessions that are not DMs yet, old ones included, but only when asked for by name.
  if (query.trim() !== '') {
    const open = new Set(state.sessions.map((x) => x.id));
    for (const sec of state.sections ?? []) {
      if (!sec.folder) continue;
      for (const info of state.folders?.[sec.id]?.sessions ?? []) {
        if (info.hidden || (info.dmId && open.has(info.dmId))) continue;
        const byName = fuzzy(query, info.name);
        const byWhere = fuzzy(query, `${info.relPath} ${info.branch ?? ''}`.trim());
        const byPath = fuzzy(query, info.launchCwd);
        const byPrompt = fuzzy(query, info.firstPrompt);
        const best = Math.max(
          byName ? byName.score * 1.5 : -1,
          byWhere ? byWhere.score : -1,
          byPath ? byPath.score * 0.5 : -1,
          byPrompt ? byPrompt.score * 0.3 : -1,
        );
        if (best < 0) continue;
        // Open DMs outrank sessions that would have to be resumed.
        out.push({
          key: `fs-${info.sessionId}`,
          lazy: { sectionId: sec.id, sectionName: sec.name, info },
          needs: false,
          unread: 0,
          at: byName?.at ?? [],
          score:
            best -
            25 +
            Math.max(0, 8 - (Date.now() - toMillis(info.lastActivity)) / 86_400_000 / 15),
        });
      }
    }
  }
  const nameOf = (r: Ranked) => r.session?.name ?? r.lazy?.info.name ?? '';
  return out.sort((a, b) => b.score - a.score || nameOf(a).localeCompare(nameOf(b)));
}

function highlight(text: string, at: number[]): ReactNode {
  if (at.length === 0) return text;
  const set = new Set(at);
  const parts: ReactNode[] = [];
  let run = '';
  let on = false;
  const flush = (key: number) => {
    if (run) parts.push(on ? <mark key={key}>{run}</mark> : run);
    run = '';
  };
  [...text].forEach((ch, i) => {
    const hit = set.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    run += ch;
  });
  flush(text.length);
  return parts;
}

/** Cmd+K: jump to any DM by typing a few letters. Fully keyboard driven. */
export function QuickSwitcher({ state, store }: { state: AppState; store: AppStore }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const ranked = useMemo(() => rankDms(state, q), [state, q]);
  const at = Math.min(sel, Math.max(0, ranked.length - 1));

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, ranked]);

  // A session live in another terminal asks before it opens: two processes corrupt one session.
  const [confirm, setConfirm] = useState<LazyHit | null>(null);
  const resume = (l: LazyHit) => void store.openFolderSession(l.sectionId, l.info.sessionId);
  const open = (r: Ranked | undefined) => {
    if (!r) return;
    if (r.session) store.openDm(r.session.id);
    else if (r.lazy) {
      if (r.lazy.info.liveElsewhere) setConfirm(r.lazy);
      else resume(r.lazy);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && store.closePanel()}
    >
      <div className="palette" role="dialog" aria-label="Quick switcher" aria-modal="true">
        <input
          className="palette__q"
          role="combobox"
          aria-expanded="true"
          aria-controls="qs-list"
          aria-activedescendant={ranked[at] ? `qs-${ranked[at].key}` : undefined}
          aria-label="Jump to a DM"
          placeholder="Jump to a DM"
          value={q}
          autoFocus
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
            setConfirm(null);
          }}
          onKeyDown={(e) => {
            if (confirm) {
              if (e.key === 'Enter') {
                e.preventDefault();
                resume(confirm);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setConfirm(null);
              }
              return;
            }
            if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
              e.preventDefault();
              setSel(Math.min(ranked.length - 1, at + 1));
            } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
              e.preventDefault();
              setSel(Math.max(0, at - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              open(ranked[at]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              store.closePanel();
            }
          }}
        />
        <ul className="palette__list" id="qs-list" role="listbox" aria-label="DMs" ref={list}>
          {ranked.map((r, i) => {
            const common = {
              id: `qs-${r.key}`,
              role: 'option' as const,
              'aria-selected': i === at,
              className: `palette__item${i === at ? ' sel' : ''}`,
              onPointerMove: () => i !== at && setSel(i),
              onClick: () => open(r),
            };
            if (r.lazy) {
              const { info, sectionName } = r.lazy;
              const age = relativeAge(toMillis(info.lastActivity));
              return (
                <li key={r.key} {...common} data-folder-session={info.sessionId}>
                  <span className="dot idle" aria-hidden="true" />
                  <ClaudeGlyph />
                  <span className="palette__name">{highlight(info.name, r.at)}</span>
                  <span className="palette__path">
                    {sectionName}
                    {info.relPath ? ` / ${info.relPath}` : ''}
                    {info.branch ? `, ${info.branch}` : ''}
                  </span>
                  <span className="palette__tags">
                    {info.liveElsewhere && <span className="tag">Live elsewhere</span>}
                    <span className="tag">{age ? `Not open, ${age}` : 'Not open'}</span>
                  </span>
                </li>
              );
            }
            const s = r.session!;
            return (
              <li key={r.key} {...common} data-dm={s.id}>
                <span className={`dot ${PRESENCE[s.status]}`} aria-hidden="true" />
                <ClaudeGlyph />
                <span className="palette__name">{highlight(s.name, r.at)}</span>
                <span className="palette__path">
                  {cwdParts(s.cwd).dir}
                  {cwdParts(s.cwd).base}
                </span>
                <span className="palette__tags">
                  {r.needs && <span className="tag needs">Needs you</span>}
                  {r.unread > 0 && <span className="tag">{r.unread} unread</span>}
                  {s.archived && <span className="tag">Archived</span>}
                  {s.id === state.activeId && <span className="tag">Open</span>}
                </span>
              </li>
            );
          })}
          {ranked.length === 0 && <li className="palette__none">No DM matches.</li>}
        </ul>
        {confirm && (
          <div className="palette__confirm" role="group" aria-label="Confirm open">
            <p>
              <strong>{confirm.info.name}</strong> is running in another terminal. Two processes on
              one session can corrupt it.
            </p>
            <div>
              <button type="button" className="btn sec" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="btn pri" onClick={() => resume(confirm)}>
                Open anyway
              </button>
            </div>
          </div>
        )}
        <p className="palette__foot">
          <kbd>{'↑'}</kbd> <kbd>{'↓'}</kbd> move <kbd>Enter</kbd> open <kbd>Esc</kbd> close
        </p>
      </div>
    </div>
  );
}
