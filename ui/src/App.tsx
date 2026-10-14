import { useEffect, useMemo, useState } from 'react';
import { resolveMode, themeVars } from './theme/index.ts';
import type { CSSProperties } from 'react';
import { ClaudeGlyph, Icon } from './components/Icon';
import { NewDmDialog } from './components/NewDmDialog';
import { Sidebar } from './components/Sidebar';
import { Terminal } from './components/Terminal';
import { loadDefaultTheme } from './lib/theme';
import { ITERM_THEME } from './lib/sessionTerminal';
import { cwdParts } from './lib/cwd';
import { getStore } from './state/runtime';
import { useAppState } from './state/store';
import type { Needs, SessionStatus } from './ipc';

const STATUS_TEXT: Record<SessionStatus, string> = {
  busy: 'Working',
  idle: 'Idle',
  waiting: 'Needs you',
  exited: 'Ended',
};

const NEEDS_TEXT: Record<Needs, string> = {
  permission: 'permission',
  question: 'question',
  other: 'dialog open',
};

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

export function App() {
  const store = getStore();
  const state = useAppState(store);
  const dark = useSystemDark();
  const { base, theme } = useMemo(() => loadDefaultTheme(), []);
  const mode = resolveMode('system', dark);
  const [newDmOpen, setNewDmOpen] = useState(false);

  useEffect(() => {
    void store.start();
  }, [store]);

  // Dropping files on the window pastes their paths, like iTerm2. Tauri only: the browser
  // never exposes real paths.
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let off: (() => void) | undefined;
    let gone = false;
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type !== 'drop') return;
        const id = store.getSnapshot().activeId;
        if (id) store.terminal(id).pastePaths(e.payload.paths);
      });
      if (gone) un();
      else off = un;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [store]);

  const style = { ...themeVars(theme, mode), colorScheme: mode } as CSSProperties;
  const active = state.sessions.find((s) => s.id === state.activeId) ?? null;
  const needsCount = state.sessions.filter((s) => s.status === 'waiting').length;
  const firstNeeding = state.sessions.find((s) => s.status === 'waiting');

  return (
    <div
      className="pr-app shell"
      data-base={base}
      data-mode={mode}
      data-theme={theme.id}
      style={style}
    >
      <div className="tb">
        <span className="tb-title">Patchroom</span>
        <span className="tb-spacer" />
        <button
          type="button"
          className="tb-act"
          disabled={!firstNeeding}
          onClick={() => firstNeeding && store.select(firstNeeding.id)}
        >
          <Icon name="inbox" />
          Needs you {needsCount > 0 && <b>{needsCount}</b>}
        </button>
      </div>

      <Sidebar
        state={state}
        onSelect={(id) => store.select(id)}
        onNewDm={() => setNewDmOpen(true)}
        onNewSection={(name) => store.createSection(name)}
        onToggleSection={(id, collapsed) => void store.setSectionCollapsed(id, collapsed)}
      />

      <main className="conv">
        {active ? (
          <header className="ch">
            <h2>
              <ClaudeGlyph />
              <span className="ch__name" title={active.name}>
                {active.name}
              </span>
            </h2>
            <span className="fid">Terminal</span>
            <div className="meta">
              <span className="ch__cwd" title={active.cwd}>
                <Icon name="folder" />
                <span className="ch__cwd-path">
                  <span className="ch__cwd-dir">{cwdParts(active.cwd).dir}</span>
                  <span className="ch__cwd-base">{cwdParts(active.cwd).base}</span>
                </span>
              </span>
              <span className="ch__status" data-status={active.status} role="status">
                {STATUS_TEXT[active.status]}
                {active.status === 'waiting' && active.needs ? `: ${NEEDS_TEXT[active.needs]}` : ''}
              </span>
            </div>
            <div className="tools">
              <label className="sel">
                <span className="sr-only">Section</span>
                <select
                  value={active.sectionId ?? ''}
                  onChange={(e) => void store.moveSession(active.id, e.target.value || null)}
                  aria-label="Section"
                >
                  <option value="">Direct messages</option>
                  {state.sections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {active.status !== 'exited' && (
                <button
                  type="button"
                  aria-label="End session"
                  title="End session"
                  onClick={() => void store.kill(active.id)}
                >
                  <Icon name="stop" />
                </button>
              )}
            </div>
          </header>
        ) : (
          <header className="ch ch--empty">
            <h2>Patchroom</h2>
          </header>
        )}

        {state.error && (
          <div className="banner" role="alert">
            <span>{state.error}</span>
            <button type="button" onClick={() => store.dismissError()}>
              Dismiss
            </button>
          </div>
        )}

        {active?.status === 'exited' && (
          <div className="exitbar" role="status" data-testid="exit-bar">
            <span>
              Process exited
              {active.exitCode === undefined || active.exitCode === null
                ? ''
                : ` with code ${active.exitCode}`}
              .
            </span>
            <button type="button" onClick={() => void store.resume(active)}>
              <Icon name="resume" />
              Resume
            </button>
          </div>
        )}

        {active && (
          // claude's live title (OSC 0/2), shown where iTerm2 shows it: above the terminal.
          // Fixed height, so a title arriving never moves the terminal.
          <div className="termbar" data-testid="term-title">
            <span className="termbar__title" title={active.title || undefined}>
              {active.title}
            </span>
          </div>
        )}

        <div className="stage" style={{ '--term-bg': ITERM_THEME.background } as CSSProperties}>
          {state.sessions.map((s) => (
            <Terminal
              key={s.id}
              terminal={store.terminal(s.id)}
              active={s.id === state.activeId}
              label={s.name}
            />
          ))}
          {state.sessions.length === 0 && state.ready && (
            <div className="empty">
              <h3>No DMs yet</h3>
              <p>Start one in a project folder. It runs claude in a real terminal.</p>
              <button type="button" className="btn pri" onClick={() => setNewDmOpen(true)}>
                New DM
              </button>
            </div>
          )}
        </div>
      </main>

      <NewDmDialog
        open={newDmOpen}
        defaultCwd={state.lastCwd}
        onClose={() => setNewDmOpen(false)}
        onCreate={(cwd, name) => store.create(cwd, name)}
        onPick={(p) => store.pickFolder(p)}
      />
    </div>
  );
}
