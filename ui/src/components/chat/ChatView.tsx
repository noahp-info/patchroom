import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ChatItem, MarkInfo, PromptAnswer, SessionInfo, SubagentItem } from '../../ipc';
import { emojiName } from '../../lib/emoji';
import { itemText } from '../../lib/itemText';
import { buildRows } from '../../lib/rows';
import { inTerminalDialog, type AppStore } from '../../state/store';
import { ChatContext } from './ChatContext';
import { ChatLog, type ScrollState } from './ChatLog';
import { Composer } from './Composer';
import { Floating } from '../Floating';
import { Icon } from '../Icon';
import { MarkList } from '../MarkList';
import type { Decor, RowActions } from './RowView';
import { MirrorBanner, TerminalWaitBanner, mirrorWhere } from './Banners';
import { StatusStrip } from './StatusStrip';
import { ThreadPane } from './ThreadPane';

export interface ChatViewProps {
  store: AppStore;
  session: SessionInfo;
  /** Chat is the visible view. Hidden, it stays mounted so scroll and drafts survive. */
  visible: boolean;
  unread: number;
  thread: ReturnType<AppStore['getSnapshot']>['thread'];
  /** The global prefs, for the status strip layout. */
  prefs: ReturnType<AppStore['getSnapshot']>['prefs'];
  /** Every pin, saved item and reaction; this view reads the ones for its DM. */
  marks: MarkInfo[];
}

/** Hands back the previous object while a row's decoration is unchanged, so memoized rows hold. */
class DecorCache {
  private readonly map = new Map<string, { sig: string; decor: Decor }>();
  reuse(key: string, d: Decor): Decor {
    const sig = JSON.stringify(d);
    const have = this.map.get(key);
    if (have && have.sig === sig) return have.decor;
    this.map.set(key, { sig, decor: d });
    return d;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall back to a hidden textarea where the async clipboard is not allowed.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

function ChatBar({
  store,
  session,
  pins,
  reactions,
  filter,
  onFilter,
}: {
  store: AppStore;
  session: SessionInfo;
  pins: MarkInfo[];
  reactions: Map<string, number>;
  filter: string | null;
  onFilter(emoji: string | null): void;
}) {
  const [open, setOpen] = useState<null | { kind: 'pins' | 'react'; rect: DOMRect }>(null);
  return (
    <div className="chatbar" role="toolbar" aria-label="Conversation tools">
      <button
        type="button"
        className="chatbar__btn"
        onClick={() => store.setPanel('search', 'dm')}
        title={'Find in this DM (\u2318F)'}
      >
        <Icon name="search" />
        <span className="sr-only">Find in this DM</span>
      </button>
      <button
        type="button"
        className="chatbar__btn"
        aria-haspopup="dialog"
        aria-expanded={open?.kind === 'pins'}
        title="Pins in this DM"
        data-testid="pins-btn"
        onClick={(e) => setOpen({ kind: 'pins', rect: e.currentTarget.getBoundingClientRect() })}
      >
        <Icon name="pin" />
        <span className="sr-only">Pins</span>
        {pins.length > 0 && <span className="ct">{pins.length}</span>}
      </button>
      <button
        type="button"
        className="chatbar__btn"
        aria-haspopup="dialog"
        aria-expanded={open?.kind === 'react'}
        aria-pressed={filter !== null}
        disabled={reactions.size === 0 && filter === null}
        title="Show messages with a reaction"
        data-testid="reaction-filter-btn"
        onClick={(e) => setOpen({ kind: 'react', rect: e.currentTarget.getBoundingClientRect() })}
      >
        <Icon name="smile" />
        <span className="sr-only">Reactions</span>
      </button>
      {filter && (
        <span className="chatbar__filter" data-testid="reaction-filter-on">
          Showing messages with <b>:{emojiName(filter)}:</b> {filter}
          <button type="button" onClick={() => onFilter(null)} aria-label="Clear reaction filter">
            <Icon name="x" />
          </button>
        </span>
      )}
      {open?.kind === 'pins' && (
        <Floating
          anchor={open.rect}
          label={`Pins in ${session.name}`}
          onClose={() => setOpen(null)}
          className="pop"
        >
          <h3 className="pop__h">Pins in {session.name}</h3>
          <MarkList
            marks={pins}
            sessions={[session]}
            store={store}
            showDm={false}
            empty="No pins yet. Hover a message and choose Pin."
            onJump={() => setOpen(null)}
            testId="pins-list"
          />
        </Floating>
      )}
      {open?.kind === 'react' && (
        <Floating
          anchor={open.rect}
          label="Filter by reaction"
          onClose={() => setOpen(null)}
          className="pop"
          role="menu"
        >
          <h3 className="pop__h">Show messages with</h3>
          <div className="pop__list">
            {[...reactions].map(([e, n]) => (
              <button
                key={e}
                type="button"
                role="menuitemradio"
                aria-checked={filter === e}
                className="ctxmenu__item"
                data-emoji={e}
                onClick={() => {
                  onFilter(e);
                  setOpen(null);
                }}
              >
                <span aria-hidden="true">{e}</span> :{emojiName(e)}: <span className="ct">{n}</span>
              </button>
            ))}
            {filter && (
              <button
                type="button"
                role="menuitem"
                className="ctxmenu__item sep"
                onClick={() => {
                  onFilter(null);
                  setOpen(null);
                }}
              >
                Show all messages
              </button>
            )}
          </div>
        </Floating>
      )}
    </div>
  );
}

/** The chat for one DM: log, composer and status strip, plus the subagent thread pane. */
export function ChatView({ store, session, visible, unread, thread, prefs, marks }: ChatViewProps) {
  const id = session.id;
  const model = store.chat(id);
  const snap = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void model.ensureLoaded();
    void model.loadDraft();
    // Leaving the DM writes any draft still waiting on its debounce.
    return () => store.flushDraft(id);
  }, [model, store, id]);

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

  const mine = useMemo(() => marks.filter((m) => m.conversationId === id), [marks, id]);
  const pins = useMemo(() => mine.filter((m) => m.kind === 'pin'), [mine]);
  const reactionCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of mine)
      if (m.kind === 'reaction' && m.emoji) out.set(m.emoji, (out.get(m.emoji) ?? 0) + 1);
    return out;
  }, [mine]);

  const filter = snap.reactionFilter;
  const rows = useMemo(() => {
    if (!filter) return buildRows(snap.items, snap.prompts);
    const keep = new Set(
      mine.filter((m) => m.kind === 'reaction' && m.emoji === filter).map((m) => m.itemKey),
    );
    return buildRows(
      snap.items.filter((it: ChatItem) => keep.has(it.key)),
      [],
    );
  }, [snap.items, snap.prompts, filter, mine]);

  // Row decorations keep their identity while unchanged, so memoized rows do not repaint.
  const [decorCache] = useState(() => new DecorCache());
  const decor = useMemo(() => {
    const by = new Map<string, MarkInfo[]>();
    for (const m of mine) by.set(m.itemKey, [...(by.get(m.itemKey) ?? []), m]);
    if (snap.hit && !by.has(snap.hit)) by.set(snap.hit, []);
    const out: Record<string, Decor> = {};
    for (const [key, list] of by) {
      const d: Decor = {
        hit: key === snap.hit,
        pinned: list.some((m) => m.kind === 'pin'),
        saved: list.some((m) => m.kind === 'saved'),
        reactions: list.filter((m) => m.kind === 'reaction' && m.emoji).map((m) => m.emoji!),
      };
      out[key] = decorCache.reuse(key, d);
    }
    return out;
  }, [mine, snap.hit, decorCache]);
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
      toggleMark: (itemKey, kind, emoji) => void store.toggleMark(id, itemKey, kind, emoji),
      copy: (item: ChatItem) => copyText(itemText(item)),
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
  const mirrored = !!session.mirror;
  const dialog = !mirrored && inTerminalDialog(session);

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
          <ChatBar
            store={store}
            session={session}
            pins={pins}
            reactions={reactionCounts}
            filter={filter}
            onFilter={(e) => model.setReactionFilter(e)}
          />
          {mirrored && (
            <MirrorBanner
              session={session}
              onArm={(on) => void store.takeoverWhenClosed(id, on)}
              onTakeoverNow={() => store.takeoverNow(id)}
            />
          )}
          {dialog && (
            <TerminalWaitBanner
              wait={session.terminalWait!}
              onShowTerminal={() =>
                store.openFallback(id, 'Answer it here. Esc or \u2318J returns to chat.')
              }
            />
          )}
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
            decor={decor}
            focus={snap.focus}
            onFocusDone={(n) => model.consumeFocus(n)}
            detached={snap.detached}
            onJumpLatest={() => model.reload()}
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
            readOnly={
              mirrored ? `Read-only: open in ${mirrorWhere(session) || 'another terminal'}` : null
            }
            blocked={dialog}
            notice={snap.notice}
            onBlocked={() =>
              model.setNotice({
                kind: 'blocked',
                text: 'Claude is showing something in the terminal. Your message is kept.',
              })
            }
            onOpenTerminal={() =>
              store.openFallback(id, 'Answer it here. Esc or \u2318J returns to chat.')
            }
            onSend={(t) => store.sendText(id, t)}
            onStop={() => store.stopTurn(id)}
            onPasteImage={(f) => store.pasteImage(id, f)}
          />
          <StatusStrip
            store={store}
            sessionId={id}
            prefs={prefs}
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
