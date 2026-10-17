import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SearchHit } from '../ipc';
import { formatStamp, toMillis } from '../lib/time';
import type { AppState, AppStore } from '../state/store';
import { Icon } from './Icon';
import { useOverlay } from '../state/overlays';

/** The snippet with its match ranges wrapped in <mark>. */
export function Snippet({ text, ranges }: { text: string; ranges: [number, number][] }): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s < at || e <= s) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={s}>{text.slice(s, e)}</mark>);
    at = e;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

const DEBOUNCE_MS = 120;

/** Cmd+F (this DM) and Cmd+Shift+F (every DM): full-text search over transcripts. */
export function SearchPanel({ state, store }: { state: AppState; store: AppStore }) {
  useOverlay('search');
  const active = state.sessions.find((s) => s.id === state.activeId) ?? null;
  const [scope, setScope] = useState<'dm' | 'all'>(active ? state.searchScope : 'all');
  const [q, setQ] = useState(state.searchSeed);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [took, setTook] = useState(0);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const scopeId = scope === 'dm' ? active?.id : undefined;

  useEffect(() => {
    const query = q.trim();
    const mine = ++seq.current;
    if (query === '') return;
    const t = window.setTimeout(() => {
      store.search(query, scopeId).then(
        (r) => {
          if (mine !== seq.current) return;
          setHits(r.hits);
          setTook(r.tookMs);
          setSel(0);
          setError(null);
        },
        (err: unknown) => {
          if (mine === seq.current) setError(`Search failed: ${String(err)}`);
        },
      );
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [q, scopeId, store]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, hits]);

  const shown = q.trim() === '' ? null : hits;
  const nameOf = (id: string) => state.sessions.find((s) => s.id === id)?.name ?? 'Deleted session';
  const open = (h: SearchHit | undefined) => h && store.openDm(h.id, { itemKey: h.itemKey });

  return (
    <div
      className="palette-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && store.closePanel()}
    >
      <div className="palette search" role="dialog" aria-label="Search" aria-modal="true">
        <div className="palette__head">
          <Icon name="search" />
          <input
            className="palette__q"
            aria-label="Search messages"
            placeholder={
              scope === 'dm' && active ? `Search ${active.name}` : 'Search every session'
            }
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              const n = shown?.length ?? 0;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel(Math.min(n - 1, sel + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel(Math.max(0, sel - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                open(shown?.[sel]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                store.closePanel();
              }
            }}
          />
          <div className="scope" role="group" aria-label="Search scope">
            <button
              type="button"
              aria-pressed={scope === 'dm'}
              disabled={!active}
              onClick={() => setScope('dm')}
            >
              This session
            </button>
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              Everywhere
            </button>
          </div>
        </div>
        {error && (
          <p className="palette__none" role="alert">
            {error}
          </p>
        )}
        <ul className="palette__list" role="listbox" aria-label="Results" ref={list}>
          {shown?.map((h, i) => {
            const ms = toMillis(h.ts);
            return (
              <li
                key={`${h.id}:${h.itemKey}`}
                role="option"
                aria-selected={i === sel}
                className={`palette__item hit${i === sel ? ' sel' : ''}`}
                data-dm={h.id}
                data-item={h.itemKey}
                onPointerMove={() => i !== sel && setSel(i)}
                onClick={() => open(h)}
              >
                <span className="hit__meta">
                  <b>{nameOf(h.id)}</b>
                  <time>{formatStamp(ms)}</time>
                </span>
                <span className="hit__snip" data-testid="hit-snippet">
                  <Snippet text={h.snippet} ranges={h.ranges} />
                </span>
              </li>
            );
          })}
          {shown?.length === 0 && <li className="palette__none">No messages match.</li>}
        </ul>
        <p className="palette__foot" role="status">
          {shown
            ? `${shown.length} ${shown.length === 1 ? 'result' : 'results'} in ${took} ms`
            : 'Type to search. Enter opens the message.'}
        </p>
      </div>
    </div>
  );
}
