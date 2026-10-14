import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import type { PromptAnswer, SessionInfo, SubagentItem } from '../../ipc';
import { buildRows } from '../../lib/rows';
import type { AppStore } from '../../state/store';
import { ChatContext } from './ChatContext';
import { ChatLog, type ScrollState } from './ChatLog';
import { Composer } from './Composer';
import type { RowActions } from './RowView';
import { StatusStrip } from './StatusStrip';
import { ThreadPane } from './ThreadPane';

export interface ChatViewProps {
  store: AppStore;
  session: SessionInfo;
  /** Chat is the visible view. Hidden, it stays mounted so scroll and drafts survive. */
  visible: boolean;
  unread: number;
  thread: ReturnType<AppStore['getSnapshot']>['thread'];
}

/** The chat for one DM: log, composer and status strip, plus the subagent thread pane. */
export function ChatView({ store, session, visible, unread, thread }: ChatViewProps) {
  const id = session.id;
  const model = store.chat(id);
  const snap = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void model.ensureLoaded();
  }, [model]);

  // On screen means read. Needs-you is never touched here.
  useEffect(() => {
    if (unread > 0 && visible && document.visibilityState === 'visible') store.markRead(id);
  }, [store, id, unread, visible]);

  // Opening the chat puts the cursor in the composer.
  useEffect(() => {
    if (!visible) return;
    const ta = root.current?.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
    const active = document.activeElement;
    if (ta && !ta.disabled && (!active || active === document.body || active.closest('.term')))
      ta.focus();
  }, [visible, id]);

  const rows = useMemo(() => buildRows(snap.items, snap.prompts), [snap.items, snap.prompts]);
  const pending = snap.prompts.filter((p) => !p.resolved).length;

  const actions = useMemo<RowActions>(
    () => ({
      store,
      sessionId: id,
      toggle: (key) => {
        model.toggleExpanded(key);
        bump();
      },
      openThread: (item: SubagentItem) =>
        store.openThread({ sessionId: id, toolUseId: item.toolUseId, title: item.description }),
      showTerminal: () => store.setView(id, 'terminal'),
      handoff: (promptId: string) => {
        void model.handoff(promptId);
        store.setView(id, 'terminal');
      },
      answer: (promptId: string, answer: PromptAnswer) => void model.answer(promptId, answer),
    }),
    [store, id, model],
  );

  const onScrollState = useCallback(
    (s: ScrollState) => {
      model.setScroll(s);
    },
    [model],
  );
  const onLoadOlder = useCallback(() => void model.loadOlder(), [model]);
  const ended = session.status === 'exited';

  const ctx = useMemo(() => ({ store, sessionId: id }), [store, id]);

  return (
    <ChatContext.Provider value={ctx}>
      <div
        ref={root}
        className={`chat${visible ? '' : ' chat--hidden'}`}
        data-testid="chat"
        aria-hidden={!visible}
        inert={!visible}
      >
        <div className="chat-main">
          {snap.error && (
            <div className="banner" role="alert">
              <span>{snap.error}</span>
              <button type="button" onClick={() => void model.reload()}>
                Retry
              </button>
            </div>
          )}
          <ChatLog
            rows={rows}
            actions={actions}
            expanded={model.expanded}
            initial={model.scroll}
            onScrollState={onScrollState}
            hasMore={snap.hasMore}
            loading={snap.loading}
            onLoadOlder={onLoadOlder}
            label={`Conversation with ${session.name}`}
            waiting={pending}
            empty={
              <div className="logempty" data-testid="chat-empty">
                {snap.loaded ? (
                  <>
                    <b>No messages yet.</b>
                    <span>
                      Say something below. <kbd>&#8984;J</kbd> shows the terminal.
                    </span>
                  </>
                ) : (
                  <span>Loading the conversation</span>
                )}
              </div>
            }
          />
          <div className="sr-only" role="status" aria-live="polite">
            {pending > 0
              ? `${pending} ${pending === 1 ? 'request needs' : 'requests need'} your answer`
              : ''}
          </div>
          <Composer
            model={model}
            name={session.name}
            busy={session.status === 'busy'}
            ended={ended}
            onSend={(t) => void store.sendText(id, t)}
            onStop={() => store.stopTurn(id)}
            onPasteImage={() => store.pasteClipboardImage(id)}
          />
          <StatusStrip
            statusline={snap.statusline}
            cwd={session.cwd}
            onCycleMode={() => store.cycleMode(id)}
          />
        </div>
        {thread && thread.sessionId === id && (
          <ThreadPane
            key={thread.toolUseId}
            model={model}
            thread={thread}
            actions={actions}
            expanded={model.expanded}
            onClose={() => store.openThread(null)}
          />
        )}
      </div>
    </ChatContext.Provider>
  );
}
