import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionInfo, SessionStatus } from '../ipc';
import { fuzzy } from '../lib/fuzzy';
import { cwdParts } from '../lib/cwd';
import type { AppState, AppStore } from '../state/store';
import { ClaudeGlyph } from './Icon';

export interface Ranked {
  session: SessionInfo;
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
  state: Pick<AppState, 'sessions' | 'badges' | 'recent'>,
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
    out.push({ session: s, needs, unread, at, score });
  }
  return out.sort((a, b) => b.score - a.score || a.session.name.localeCompare(b.session.name));
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

  const open = (r: Ranked | undefined) => {
    if (r) store.openDm(r.session.id);
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
          aria-activedescendant={ranked[at] ? `qs-${ranked[at].session.id}` : undefined}
          aria-label="Jump to a DM"
          placeholder="Jump to a DM"
          value={q}
          autoFocus
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
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
          {ranked.map((r, i) => (
            <li
              key={r.session.id}
              id={`qs-${r.session.id}`}
              role="option"
              aria-selected={i === at}
              className={`palette__item${i === at ? ' sel' : ''}`}
              data-dm={r.session.id}
              onPointerMove={() => i !== at && setSel(i)}
              onClick={() => open(r)}
            >
              <span className={`dot ${PRESENCE[r.session.status]}`} aria-hidden="true" />
              <ClaudeGlyph />
              <span className="palette__name">{highlight(r.session.name, r.at)}</span>
              <span className="palette__path">
                {cwdParts(r.session.cwd).dir}
                {cwdParts(r.session.cwd).base}
              </span>
              <span className="palette__tags">
                {r.needs && <span className="tag needs">Needs you</span>}
                {r.unread > 0 && <span className="tag">{r.unread} unread</span>}
                {r.session.archived && <span className="tag">Archived</span>}
                {r.session.id === state.activeId && <span className="tag">Open</span>}
              </span>
            </li>
          ))}
          {ranked.length === 0 && <li className="palette__none">No DM matches.</li>}
        </ul>
        <p className="palette__foot">
          <kbd>{'↑'}</kbd> <kbd>{'↓'}</kbd> move <kbd>Enter</kbd> open <kbd>Esc</kbd> close
        </p>
      </div>
    </div>
  );
}
