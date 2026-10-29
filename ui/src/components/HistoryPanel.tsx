import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HistoryGroup, HistorySession } from '../ipc';
import { relativeAge, relativeAgeLong } from '../lib/folder';
import {
  HISTORY_GROUPS,
  filterHistory,
  folderParts,
  groupHistory,
  modelDisplay,
  type HistoryBucket,
} from '../lib/history';
import { hintPlace } from '../lib/hints';
import { toMillis } from '../lib/time';
import type { AppState, AppStore } from '../state/store';
import { Hint } from './Hint';
import { Icon } from './Icon';

/** Rows a group shows before "Show more", and how many each click adds. */
export const HISTORY_PAGE = 40;
/** Groups open on first view, newest first. The rest start collapsed. */
const OPEN_GROUPS = 3;
/** A listing younger than this is reused when the panel opens again. */
const FRESH_MS = 15_000;

/**
 * History: every Claude Code session on this Mac, grouped so thousands stay scannable. The
 * header toggles the grouping (remembered in prefs); search filters within it. Groups collapse
 * and page, so only what is open renders. Opening a row resumes it in its folder.
 */
export function HistoryPanel({ state, store }: { state: AppState; store: AppStore }) {
  const by: HistoryGroup = state.prefs?.history?.groupBy ?? 'folder';
  const [q, setQ] = useState('');
  /** Per grouping: which group keys the person opened or closed by hand. */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const [confirm, setConfirm] = useState<HistorySession | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const h = state.history;

  useEffect(() => {
    void store.loadHistory(FRESH_MS);
    store.showHint('history.group');
  }, [store]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (confirm) setConfirm(null);
      else if (q && document.activeElement === field.current) setQ('');
      else store.closePanel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [store, confirm, q]);

  const searching = q.trim() !== '';
  const words = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const buckets = useMemo<HistoryBucket[]>(
    () => groupHistory(filterHistory(h.sessions, q, state.catalog), by, state.catalog),
    [h.sessions, q, by, state.catalog],
  );
  const matched = buckets.reduce((n, b) => n + b.sessions.length, 0);
  const isOpen = (b: HistoryBucket, i: number) =>
    toggled[`${by}:${b.key}`] ?? (searching || i < OPEN_GROUPS);
  const toggle = (b: HistoryBucket, i: number) =>
    setToggled({ ...toggled, [`${by}:${b.key}`]: !isOpen(b, i) });
  const open = (r: HistorySession) => {
    if (r.liveState === 'live' && !r.dmId) setConfirm(r);
    else void store.openHistorySession(r.sessionId);
  };
  const openDms = new Set(state.sessions.map((s) => s.id));

  return (
    <section className="panelview history" aria-label="History" data-testid="history">
      <header className="panelview__h">
        <div>
          <h2>History</h2>
          <p>Every Claude Code session on this Mac. Open one to resume it in its folder.</p>
        </div>
        <button
          type="button"
          className="ib"
          aria-label="Close History"
          onClick={() => store.closePanel()}
        >
          <Icon name="x" />
        </button>
      </header>
      <div className="history__bar">
        <label className="history__q">
          <Icon name="search" />
          <input
            ref={field}
            type="search"
            aria-label="Filter sessions"
            placeholder="Filter sessions"
            title="Matches the title, first message, folder, branch and model"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="history-filter"
          />
        </label>
        <div className="scope history__by" role="group" aria-label="Group by">
          {HISTORY_GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={by === g.id}
              data-group={g.id}
              onClick={() => store.setHistoryGroup(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ib"
          aria-label="Refresh History"
          title="Refresh"
          disabled={h.loading}
          onClick={() => void store.loadHistory()}
        >
          <Icon name="resume" />
        </button>
      </div>
      {state.hint && hintPlace(state.hint) === 'panel' && (
        <div className="history__hint">
          <Hint store={store} id={state.hint} vars={state.hintVars} />
        </div>
      )}
      <div className="panelview__body history__body">
        <p className="history__count" role="status" data-testid="history-count">
          {h.loading && h.at === 0
            ? 'Reading your sessions…'
            : searching
              ? `${matched} of ${h.sessions.length} sessions match, in ${buckets.length} ${
                  buckets.length === 1 ? 'group' : 'groups'
                }`
              : `${h.sessions.length} sessions in ${buckets.length} ${
                  buckets.length === 1 ? 'group' : 'groups'
                }`}
        </p>
        {h.error && (
          <p className="history__err" role="alert">
            Could not read the sessions: {h.error}
          </p>
        )}
        {h.at > 0 && buckets.length === 0 && (
          <p className="listempty">
            {searching ? 'No session matches.' : 'No Claude Code sessions found on this Mac.'}
          </p>
        )}
        {buckets.map((b, i) => {
          const on = isOpen(b, i);
          const shown = pages[`${by}:${b.key}`] ?? HISTORY_PAGE;
          const id = `hg-${by}-${i}`;
          return (
            <section className="hgroup" key={`${by}:${b.key}`} data-group-key={b.key}>
              <h3 className="hgroup__h">
                <button
                  type="button"
                  aria-expanded={on}
                  aria-controls={id}
                  onClick={() => toggle(b, i)}
                  title={b.detail ? `${b.detail}/${b.label}` : b.label}
                >
                  <Icon name={on ? 'down' : 'right'} />
                  <span className="hgroup__name">{b.label}</span>
                  {b.detail && <span className="hgroup__detail">{b.detail}</span>}
                  <span className="hgroup__ct">{b.sessions.length}</span>
                </button>
              </h3>
              {on && (
                <ul className="hlist" id={id}>
                  {b.sessions.slice(0, shown).map((r) => (
                    <HistoryRow
                      key={r.sessionId}
                      row={r}
                      by={by}
                      model={modelDisplay(state.catalog, r.model)}
                      words={words}
                      inPatchroom={!!r.dmId && openDms.has(r.dmId)}
                      confirming={confirm?.sessionId === r.sessionId}
                      onOpen={() => open(r)}
                      onConfirm={() => {
                        setConfirm(null);
                        void store.openHistorySession(r.sessionId);
                      }}
                      onCancel={() => setConfirm(null)}
                    />
                  ))}
                  {b.sessions.length > shown && (
                    <li className="hlist__more">
                      <button
                        type="button"
                        className="btn sec"
                        onClick={() =>
                          setPages({ ...pages, [`${by}:${b.key}`]: shown + HISTORY_PAGE })
                        }
                      >
                        Show {Math.min(HISTORY_PAGE, b.sessions.length - shown)} more of{' '}
                        {b.sessions.length - shown}
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

/** `text` with every filter word marked, case-insensitively. */
function marked(text: string, words: string[]): ReactNode {
  if (words.length === 0) return text;
  const low = text.toLowerCase();
  const on = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) {
      for (let k = i; k < i + w.length; k++) on[k] = true;
    }
  }
  const out: ReactNode[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || on[i] !== on[start]) {
      const part = text.slice(start, i);
      out.push(on[start] ? <mark key={start}>{part}</mark> : part);
      start = i;
    }
  }
  return out;
}

function HistoryRow({
  row,
  by,
  model,
  words,
  inPatchroom,
  confirming,
  onOpen,
  onConfirm,
  onCancel,
}: {
  row: HistorySession;
  by: HistoryGroup;
  model: string;
  /** Filter words to mark in the row. */
  words: string[];
  inPatchroom: boolean;
  confirming: boolean;
  onOpen(): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  const ms = toMillis(row.lastActivity);
  const showPrompt = row.firstPrompt && row.firstPrompt !== row.title;
  // The meta line names what the grouping does not already say.
  const meta = [
    by !== 'folder' ? folderParts(row.folder).name : null,
    by !== 'branch' ? row.branch : null,
    by !== 'model' && row.model ? model : null,
  ].filter(Boolean);
  return (
    <li className="hrow-wrap" data-session={row.sessionId}>
      <button
        type="button"
        className="hrow"
        onClick={onOpen}
        aria-label={`${row.title}${inPatchroom ? ', open in Patchroom' : ''}${
          row.liveState === 'live' ? ', running in another terminal' : ''
        }`}
      >
        <span className="hrow__main">
          <span className="hrow__line">
            <span className="hrow__title">{marked(row.title, words)}</span>
            {meta.length > 0 && (
              <span className="hrow__meta">{marked(meta.join(' · '), words)}</span>
            )}
          </span>
          {showPrompt && <span className="hrow__prompt">{marked(row.firstPrompt, words)}</span>}
        </span>
        <span className="hrow__side">
          {inPatchroom && (
            <span className="tag" data-testid="history-open-tag">
              Open
            </span>
          )}
          {row.liveState === 'live' && <span className="tag">Live elsewhere</span>}
          <time dateTime={new Date(ms).toISOString()} title={relativeAgeLong(ms)}>
            {relativeAge(ms)}
          </time>
        </span>
      </button>
      {confirming && (
        <div className="hrow__confirm" role="group" aria-label="Confirm open">
          <p>
            This session runs in another terminal. It opens as a read-only mirror. Patchroom never
            starts a second copy.
          </p>
          <div className="hrow__btns">
            <button type="button" className="btn sec" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn pri" onClick={onConfirm}>
              Open mirror
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
