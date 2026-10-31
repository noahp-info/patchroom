import { hintPlace } from './lib/hints';
import { RestartDialog } from './components/RestartDialog';
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { ClaudeGlyph, Icon } from './components/Icon';
import { NewDmDialog } from './components/NewDmDialog';
import { ActivityView, PrefsView, SavedView } from './components/PanelViews';
import { HistoryPanel } from './components/HistoryPanel';
import { QuickSwitcher } from './components/QuickSwitcher';
import { SearchPanel } from './components/SearchPanel';
import { SelectionMenu } from './components/SelectionMenu';
import { ViewerPane } from './components/ViewerPane';
import { Hint } from './components/Hint';
import { ShotOverlay } from './components/ShotOverlay';
import { ChatView } from './components/chat/ChatView';
import { useFullscreen } from './lib/fullscreen';
import { Sidebar } from './components/Sidebar';
import { clampSidebar, SIDEBAR_DEFAULT } from './components/SidebarResizer';
import { PatchCable } from './theme/PatchCable';
import { Terminal } from './components/Terminal';
import { playNotifySound, useThemeRuntime } from './lib/prefsModule';
import { ITERM_THEME } from './lib/sessionTerminal';
import { cwdParts } from './lib/cwd';
import { launchFolders } from './lib/folder';
import { shellQuotePath } from './lib/keys';
import { termbarStyle } from './lib/termbar';
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

/** Presence class for the Patch Bay jack; other bases hide the jack. */
function jackState(status: SessionStatus): 'busy' | 'idle' | 'needs' {
  if (status === 'busy') return 'busy';
  if (status === 'waiting') return 'needs';
  return 'idle';
}

export function App() {
  const store = getStore();
  const state = useAppState(store);
  const { base, theme, mode, style: themeStyle } = useThemeRuntime();
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [chatSlot, setChatSlot] = useState<HTMLElement | null>(null);
  // A folder section id when the dialog was opened from that section.
  const [newDmSection, setNewDmSection] = useState<string | null>(null);
  const dmSection = state.sections.find((x) => x.id === newDmSection && x.folder) ?? null;

  // The sidebar width: the saved pref, or the live value while a drag or key press is in flight.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const sidebarWidth = liveWidth ?? clampSidebar(state.prefs?.sidebarWidth ?? SIDEBAR_DEFAULT);
  const commitWidth = (w: number) => {
    setLiveWidth(w);
    void store.setPrefs({ sidebarWidth: w }).finally(() => setLiveWidth(null));
  };

  useEffect(() => {
    void store.start();
  }, [store]);

  // App shortcuts. Captured on the window so xterm and the composer never see them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const act = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      const snap = store.getSnapshot();
      // A terminal opened as a fallback (a TUI panel or dialog): Esc reaches the TUI, which
      // closes the panel, and the view returns to chat right after.
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const id = snap.activeId;
        if (
          id &&
          !snap.panel &&
          store.viewOf(id) === 'terminal' &&
          snap.termNotes[id] !== undefined
        ) {
          window.setTimeout(() => store.setView(id, 'chat'), 0);
        }
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (key === 'j' && !e.shiftKey) {
          const id = snap.activeId;
          if (id) act(() => store.toggleView(id));
        } else if (key === 'k' && !e.shiftKey) {
          act(() => store.setPanel(snap.panel === 'switcher' ? null : 'switcher'));
        } else if (key === 'a' && e.shiftKey) {
          act(() => void store.jumpOldestNeeds());
        } else if (key === 'f' && e.shiftKey) {
          act(() => store.setPanel('search', 'all'));
        } else if (key === 'f' && !e.shiftKey) {
          // Settings has its own search field: Cmd+F focuses it there.
          if (snap.panel !== 'prefs')
            act(() => store.setPanel('search', snap.activeId ? 'dm' : 'all'));
        } else if (key === ',' && !e.shiftKey) {
          act(() => store.setPanel(snap.panel === 'prefs' ? null : 'prefs'));
        } else if (e.shiftKey && (e.code === 'Digit2' || key === '2' || key === '@')) {
          // The app menu owns these in the real app; this covers the page (and the browser).
          act(() => void store.startShot());
        } else if (e.shiftKey && key === 'm') {
          act(() => store.commentOnSelection());
        }
      } else if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'ArrowDown') act(() => store.jumpUnread(1));
        else if (e.key === 'ArrowUp') act(() => store.jumpUnread(-1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store]);

  // The backend decides whether to alert; this only plays the matching sound.
  useEffect(() => store.onNotify((e) => playNotifySound(e.event, e.id)), [store]);

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
        if (!id) return;
        if (store.viewOf(id) === 'chat') {
          store.chat(id).insertIntoDraft(e.payload.paths.map(shellQuotePath).join(' ') + ' ');
        } else store.terminal(id).pastePaths(e.payload.paths);
      });
      if (gone) un();
      else off = un;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [store]);

  const fullscreen = useFullscreen();
  const style = { ...themeStyle, '--side-w': `${sidebarWidth}px` } as CSSProperties;
  const active = state.sessions.find((s) => s.id === state.activeId) ?? null;
  const needsYou = (s: { id: string; status: SessionStatus }) =>
    s.status === 'waiting' || (state.badges[s.id]?.needsYou ?? 0) > 0;
  const needsCount = state.sessions.filter((s) => !s.archived && needsYou(s)).length;
  const panelOpen =
    state.panel === 'activity' || state.panel === 'saved' || state.panel === 'history';
  const view = active ? (state.views[active.id] ?? 'chat') : 'chat';

  return (
    <div
      className="pr-app shell"
      data-base={base}
      data-mode={mode}
      data-theme={theme.id}
      data-fullscreen={fullscreen ? 'true' : undefined}
      data-viewer={state.viewer ? 'open' : undefined}
      data-emoji={state.prefs?.emoji?.chat ?? 'apple'}
      style={style}
      onClickCapture={(e) => {
        // Links never navigate the app: they open in the viewer or the browser (Links pref).
        const a = (e.target as Element).closest?.('a[href]');
        if (!a || e.button !== 0) return;
        const href = a.getAttribute('href') ?? '';
        if (!/^https?:\/\//i.test(href)) return;
        e.preventDefault();
        e.stopPropagation();
        store.openLink(href, { invert: e.metaKey });
      }}
    >
      <div className="tb" data-testid="topbar" data-tauri-drag-region>
        <span className="tb-spacer" data-tauri-drag-region />
        <button
          type="button"
          className="tb-search"
          onClick={() => store.setPanel('switcher')}
          aria-label="Jump to a session"
          title={'Jump to a session (\u2318K)'}
        >
          <Icon name="search" />
          <span>Jump to a session</span>
          <kbd>{'\u2318K'}</kbd>
        </button>
        <span className="tb-spacer" data-tauri-drag-region />
        {/* Shown only while something waits on the user: a dim, disabled label read as broken. */}
        {needsCount > 0 && (
          <button
            type="button"
            className="tb-act"
            title={'Oldest session that needs you (\u2318\u21E7A)'}
            onClick={() => void store.jumpOldestNeeds()}
          >
            <Icon name="inbox" />
            Needs you <b>{needsCount}</b>
          </button>
        )}
      </div>

      <Sidebar
        state={state}
        store={store}
        width={sidebarWidth}
        onResizePreview={setLiveWidth}
        onResizeCommit={commitWidth}
        onNewDm={(sectionId) => {
          setNewDmSection(sectionId ?? null);
          setNewDmOpen(true);
        }}
      />

      <main className="conv">
        {active ? (
          <header className="ch" inert={panelOpen}>
            <span className={`jack ${jackState(active.status)} plugged`} data-jack-to="" />
            <h2>
              <ClaudeGlyph />
              <span className="ch__name" title={active.name}>
                {active.name}
              </span>
            </h2>
            <span className="sr-only" data-testid="view-label" role="status">
              {view === 'chat' ? 'Chat' : 'Terminal'}
            </span>
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
                {active.status === 'waiting' && active.needs && (
                  <span className="ch__status-more">: {NEEDS_TEXT[active.needs]}</span>
                )}
              </span>
            </div>
            <div className="tools">
              {/* Chat tools (find, pins, reactions) portal in here from the chat view. */}
              <div className="ch__chat" data-slot="chat-tools" ref={setChatSlot} />
              <div className="viewseg" role="group" aria-label="View" data-testid="view-toggle">
                <button
                  type="button"
                  aria-label="Chat"
                  title="Chat (\u2318J)"
                  aria-pressed={view === 'chat'}
                  onClick={() => store.switchView(active.id, 'chat')}
                >
                  <Icon name="chat" />
                </button>
                <button
                  type="button"
                  aria-label="Terminal"
                  title={active.mirror ? 'Runs in another terminal' : 'Terminal (\u2318J)'}
                  aria-pressed={view === 'terminal'}
                  disabled={!!active.mirror}
                  onClick={() => store.switchView(active.id, 'terminal')}
                >
                  <Icon name="term" />
                </button>
              </div>
              <label className="sel">
                <span className="sr-only">Section</span>
                <select
                  value={active.sectionId ?? ''}
                  onChange={(e) => void store.moveSession(active.id, e.target.value || null)}
                  aria-label="Section"
                >
                  <option value="">Sessions</option>
                  {state.sections
                    .filter((s) => s.kind !== 'divider')
                    .map((s) => (
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

        {state.hint && hintPlace(state.hint) === 'header' && (
          <Hint store={store} id={state.hint} vars={state.hintVars} />
        )}
        {state.restart && <RestartDialog store={store} state={state} />}

        {state.checkFailed && (
          <div
            className="cfbar"
            role="alertdialog"
            aria-label="Could not check"
            data-testid="check-failed"
          >
            <Icon name="lock" />
            <div className="cfbar__text">
              <b>Could not check whether {state.checkFailed.name} is open in another terminal</b>
              <span data-testid="check-failed-reason">{state.checkFailed.reason}</span>
              <span className="cfbar__warn" data-testid="check-failed-warning">
                Warning: if it is running elsewhere, opening it now starts a second process on the
                same session. Two processes can overwrite each other&apos;s history.
              </span>
            </div>
            <button type="button" className="cfbar__btn" onClick={() => store.dismissCheckFailed()}>
              Cancel
            </button>
            <button
              type="button"
              className="cfbar__btn cfbar__btn--warn"
              data-testid="open-anyway"
              onClick={() => void store.openAnyway()}
            >
              Open anyway
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

        <div className="pane" inert={panelOpen}>
          {active && (
            // claude's live title (OSC 0/2), shown where iTerm2 shows it: above the terminal.
            // Fixed height, so a title arriving never moves the terminal.
            <div
              className={`termbar${view === 'chat' ? ' termbar--off' : ''}`}
              data-testid="term-title"
              style={termbarStyle(
                (state.activeId && state.termBg[state.activeId]) || ITERM_THEME.background,
              )}
            >
              <span className="termbar__title" title={active.title || undefined}>
                {active.title}
              </span>
            </div>
          )}

          {active && view === 'terminal' && state.termNotes[active.id] !== undefined && (
            <div className="tnote" role="status" data-testid="term-note">
              <span>{state.termNotes[active.id]}</span>
              <button type="button" onClick={() => store.setView(active.id, 'chat')}>
                Back to chat
              </button>
            </div>
          )}

          {active && view === 'terminal' && state.termToast?.id === active.id && (
            <div className="tnote" role="status" data-testid="term-toast">
              <span>{state.termToast.text}</span>
            </div>
          )}

          <div
            className="stage"
            style={
              {
                '--term-bg':
                  (state.activeId && state.termBg[state.activeId]) || ITERM_THEME.background,
              } as CSSProperties
            }
          >
            {state.sessions.map((s) => (
              <Terminal
                key={s.id}
                terminal={store.terminal(s.id)}
                active={s.id === state.activeId}
                visible={s.id === state.activeId && (state.views[s.id] ?? 'chat') === 'terminal'}
                label={s.name}
              />
            ))}
            {state.sessions.length === 0 && state.ready && (
              <div className="empty">
                <h3>No sessions yet</h3>
                <p>Start one in a project folder. It runs claude in a real terminal.</p>
                <button type="button" className="btn pri" onClick={() => setNewDmOpen(true)}>
                  New session
                </button>
              </div>
            )}
          </div>
          {active && (
            <ChatView
              key={active.id}
              store={store}
              session={active}
              visible={view === 'chat'}
              unread={state.badges[active.id]?.unread ?? 0}
              thread={state.thread}
              prefs={state.prefs}
              marks={state.marks}
              toolSlot={chatSlot}
              hint={state.hint}
              hintVars={state.hintVars}
              modelSwitch={state.modelSwitch[active.id]}
              catalog={state.catalog}
            />
          )}
        </div>
        {state.panel === 'activity' && <ActivityView state={state} store={store} />}
        {state.panel === 'saved' && <SavedView state={state} store={store} />}
        {state.panel === 'history' && <HistoryPanel state={state} store={store} />}
      </main>

      {state.viewer && (
        <ViewerPane
          store={store}
          viewer={state.viewer}
          covered={state.overlays > 0 || state.shot !== null}
        />
      )}

      <PatchCable
        remeasureKey={`${base}/${theme.id}/${mode}/${state.activeId ?? ''}/${state.panel ?? ''}`}
      />

      {state.panel === 'prefs' && <PrefsView state={state} store={store} />}
      {state.panel === 'switcher' && <QuickSwitcher state={state} store={store} />}
      {state.panel === 'search' && <SearchPanel state={state} store={store} />}
      <SelectionMenu store={store} activeId={state.panel ? null : state.activeId} />
      {state.shot && <ShotOverlay store={store} shot={state.shot} />}

      <NewDmDialog
        open={newDmOpen}
        defaultCwd={dmSection?.folder ?? state.lastCwd}
        section={dmSection ? { id: dmSection.id, name: dmSection.name } : null}
        folders={
          dmSection?.folder
            ? launchFolders(dmSection.folder, state.folders[dmSection.id]?.sessions ?? [])
            : []
        }
        onClose={() => setNewDmOpen(false)}
        onCreate={(cwd, name, emoji) => store.create(cwd, name, dmSection?.id ?? null, emoji)}
        onPick={(p) => store.pickFolder(p)}
      />
    </div>
  );
}
