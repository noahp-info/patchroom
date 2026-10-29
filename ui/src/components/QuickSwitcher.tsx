import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FolderSession, SessionInfo, SessionStatus } from '../ipc';
import { relativeAge } from '../lib/folder';
import { toMillis } from '../lib/time';
import { fuzzy } from '../lib/fuzzy';
import { cwdParts } from '../lib/cwd';
import type { AppState, AppStore } from '../state/store';
import { ClaudeGlyph, Icon } from './Icon';
import { useOverlay } from '../state/overlays';

/** A folder-section session that is not a DM yet. Opening it resumes it. */
export interface LazyHit {
  sectionId: string;
  sectionName: string;
  info: FolderSession;
}

export interface Ranked {
  /** Set for an open DM. */
  session?: SessionInfo;
  /** The final "Search messages for" row: the query to search. */
  search?: string;
  /** Set for a session found in a folder section but not opened. */
  lazy?: LazyHit;
  /** Stable option id. */
  key: string;
  needs: boolean;
  unread: number;
  /** Matched offsets in the DM name. */
  at: number[];
  /** Set when only the first message matched: the message and the matched offsets in it. */
  prompt?: { text: string; at: number[] };
  /** 1: the name, folder or path matched. 0: only the first message did. Tier sorts first. */
  tier: number;
  score: number;
}

const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * Whole-word match of `query` in `text`: every query word equals a word of the text, case
 * insensitive. The last query word may be the start of a word, so typing narrows as it goes.
 * Null when any word is missing. Scores rise with the number of words and an early first hit.
 */
export function wordMatch(query: string, text: string): { score: number; at: number[] } | null {
  const qs = query.toLowerCase().match(WORD) ?? [];
  if (qs.length === 0 || !text) return null;
  const words = [...text.matchAll(WORD)].map((m) => ({
    w: m[0].toLowerCase(),
    i: m.index,
  }));
  const at: number[] = [];
  let first = Infinity;
  for (let k = 0; k < qs.length; k++) {
    const q = qs[k];
    const last = k === qs.length - 1;
    const hit =
      words.find((x) => x.w === q) ?? (last ? words.find((x) => x.w.startsWith(q)) : undefined);
    if (!hit) return null;
    first = Math.min(first, hit.i);
    for (let j = 0; j < q.length; j++) at.push(hit.i + j);
  }
  return { score: 20 + qs.length * 10 - Math.min(10, first / 20), at: at.sort((a, b) => a - b) };
}

/** The first message of each Claude session id and DM id, from History and folder listings. */
function firstPrompts(state: Partial<Pick<AppState, 'history' | 'folders'>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of state.history?.sessions ?? []) if (r.dmId) out.set(r.dmId, r.firstPrompt);
  for (const l of Object.values(state.folders ?? {}))
    for (const r of l.sessions) if (r.dmId && !out.has(r.dmId)) out.set(r.dmId, r.firstPrompt);
  return out;
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
    Partial<Pick<AppState, 'sections' | 'folders' | 'history'>>,
  query: string,
): Ranked[] {
  const out: Ranked[] = [];
  const asked = query.trim() !== '';
  const prompts = asked ? firstPrompts(state) : new Map<string, string>();
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
    let tier = 1;
    let prompt: Ranked['prompt'];
    if (asked) {
      const byName = fuzzy(query, s.name);
      const byFolder = fuzzy(query, cwdParts(s.cwd).base);
      const byPath = fuzzy(query, s.cwd);
      const best = Math.max(
        byName ? byName.score * 1.5 : -1,
        byFolder ? byFolder.score : -1,
        byPath ? byPath.score * 0.5 : -1,
      );
      if (best >= 0) {
        score += best;
        at = byName?.at ?? [];
      } else {
        const text = prompts.get(s.id) ?? '';
        const byPrompt = wordMatch(query, text);
        if (!byPrompt) continue;
        tier = 0;
        score += byPrompt.score;
        prompt = { text, at: byPrompt.at };
      }
    }
    out.push({ key: s.id, session: s, needs, unread, at, prompt, tier, score });
  }
  // Folder sessions that are not DMs yet, old ones included, but only when asked for by name.
  if (asked) {
    const open = new Set(state.sessions.map((x) => x.id));
    for (const sec of state.sections ?? []) {
      if (!sec.folder) continue;
      for (const info of state.folders?.[sec.id]?.sessions ?? []) {
        if (info.hidden || (info.dmId && open.has(info.dmId))) continue;
        const byName = fuzzy(query, info.name);
        const byWhere = fuzzy(query, `${info.relPath} ${info.branch ?? ''}`.trim());
        const byPath = fuzzy(query, info.launchCwd);
        let best = Math.max(
          byName ? byName.score * 1.5 : -1,
          byWhere ? byWhere.score : -1,
          byPath ? byPath.score * 0.5 : -1,
        );
        let tier = 1;
        let prompt: Ranked['prompt'];
        if (best < 0) {
          const byPrompt = wordMatch(query, info.firstPrompt);
          if (!byPrompt) continue;
          best = byPrompt.score;
          tier = 0;
          prompt = { text: info.firstPrompt, at: byPrompt.at };
        }
        // Open DMs outrank sessions that would have to be resumed.
        out.push({
          key: `fs-${info.sessionId}`,
          lazy: { sectionId: sec.id, sectionName: sec.name, info },
          needs: false,
          unread: 0,
          at: byName?.at ?? [],
          prompt,
          tier,
          score:
            best -
            25 +
            Math.max(0, 8 - (Date.now() - toMillis(info.lastActivity)) / 86_400_000 / 15),
        });
      }
    }
  }
  const nameOf = (r: Ranked) => r.session?.name ?? r.lazy?.info.name ?? '';
  // A name (or folder) match always beats a first-message match.
  return out.sort(
    (a, b) => b.tier - a.tier || b.score - a.score || nameOf(a).localeCompare(nameOf(b)),
  );
}

/** The ranked rows plus the closing "Search messages for" row, for a non-empty query. */
export function switcherRows(ranked: Ranked[], query: string): Ranked[] {
  const q = query.trim();
  if (!q) return ranked;
  return [
    ...ranked,
    { key: 'search-messages', search: q, needs: false, unread: 0, at: [], tier: -1, score: 0 },
  ];
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
  useOverlay('switcher');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const ranked = useMemo(() => switcherRows(rankDms(state, q), q), [state, q]);
  // First messages of open sessions come from History; refresh it in the background.
  useEffect(() => {
    void store.loadHistory(60_000);
  }, [store]);
  const at = Math.min(sel, Math.max(0, ranked.length - 1));

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, ranked]);

  // A session live in another terminal asks first: it opens as a read-only mirror, never a second copy.
  const [confirm, setConfirm] = useState<LazyHit | null>(null);
  const resume = (l: LazyHit) => void store.openFolderSession(l.sectionId, l.info.sessionId);
  const open = (r: Ranked | undefined) => {
    if (!r) return;
    if (r.search) store.searchFor(r.search);
    else if (r.session) store.openDm(r.session.id);
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
          aria-label="Jump to a session"
          placeholder="Jump to a session"
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
        <ul className="palette__list" id="qs-list" role="listbox" aria-label="Sessions" ref={list}>
          {!ranked.some((r) => !r.search) && <li className="palette__none">No session matches.</li>}
          {ranked.map((r, i) => {
            const common = {
              id: `qs-${r.key}`,
              role: 'option' as const,
              'aria-selected': i === at,
              className: `palette__item${i === at ? ' sel' : ''}`,
              onPointerMove: () => i !== at && setSel(i),
              onClick: () => open(r),
            };
            if (r.search) {
              return (
                <li
                  key={r.key}
                  {...common}
                  className={`${common.className} palette__search`}
                  data-search-row=""
                >
                  <Icon name="search" />
                  <span className="palette__name">
                    Search messages for <b>&#8220;{r.search}&#8221;</b>
                  </span>
                  <span className="palette__tags">
                    <kbd>{'⌘⇧F'}</kbd>
                  </span>
                </li>
              );
            }
            if (r.lazy) {
              const { info, sectionName } = r.lazy;
              const age = relativeAge(toMillis(info.lastActivity));
              return (
                <li key={r.key} {...common} data-folder-session={info.sessionId}>
                  <span className="dot idle" aria-hidden="true" />
                  <ClaudeGlyph />
                  <span className="palette__name">{highlight(info.name, r.at)}</span>
                  {r.prompt ? (
                    <span className="palette__path palette__prompt" data-testid="qs-prompt">
                      {highlight(r.prompt.text, r.prompt.at)}
                    </span>
                  ) : (
                    <span className="palette__path">
                      {sectionName}
                      {info.relPath ? ` / ${info.relPath}` : ''}
                      {info.branch ? `, ${info.branch}` : ''}
                    </span>
                  )}
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
                {r.prompt ? (
                  <span className="palette__path palette__prompt" data-testid="qs-prompt">
                    {highlight(r.prompt.text, r.prompt.at)}
                  </span>
                ) : (
                  <span className="palette__path">
                    {cwdParts(s.cwd).dir}
                    {cwdParts(s.cwd).base}
                  </span>
                )}
                <span className="palette__tags">
                  {r.needs && <span className="tag needs">Needs you</span>}
                  {r.unread > 0 && <span className="tag">{r.unread} unread</span>}
                  {s.archived && <span className="tag">Archived</span>}
                  {s.id === state.activeId && <span className="tag">Open</span>}
                </span>
              </li>
            );
          })}
        </ul>
        {confirm && (
          <div className="palette__confirm" role="group" aria-label="Confirm open">
            <p>
              <strong>{confirm.info.name}</strong> is running in another terminal. It opens as a
              read-only mirror. Patchroom never starts a second copy.
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
