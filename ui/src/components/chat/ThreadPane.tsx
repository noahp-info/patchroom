import { useEffect, useMemo, useState } from 'react';
import { buildRows } from '../../lib/rows';
import type { ChatModel } from '../../state/chat';
import type { OpenThread } from '../../state/store';
import { Icon } from '../Icon';
import { ChatLog, type ScrollState } from './ChatLog';
import type { RowActions } from './RowView';

export interface ThreadPaneProps {
  model: ChatModel;
  thread: OpenThread;
  actions: RowActions;
  expanded: ReadonlySet<string>;
  onClose(): void;
}

const NOOP = () => undefined;
const START: ScrollState = { top: 0, atBottom: true };

/** A subagent's items, in the right pane. Same rows as the main log, fed by `chat_thread`. */
export function ThreadPane({ model, thread, actions, expanded, onClose }: ThreadPaneProps) {
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const off = model.subscribeThread(thread.toolUseId, () => setTick((t) => t + 1));
    model.loadThread(thread.toolUseId).then(
      () => setLoaded(true),
      (err: unknown) => {
        setError(`Could not load the thread: ${String(err)}`);
        setLoaded(true);
      },
    );
    return off;
  }, [model, thread.toolUseId]);

  const rows = useMemo(
    () => buildRows(model.threadItems(thread.toolUseId), []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, thread.toolUseId, tick],
  );

  return (
    <aside
      className="thr"
      aria-label={`Subagent thread: ${thread.title}`}
      data-testid="thread-pane"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <header className="thr-h">
        <div className="thr-t">
          <b>Subagent</b>
          <span className="thr-sub" title={thread.title}>
            {thread.title}
          </span>
        </div>
        <button
          type="button"
          className="ib"
          aria-label="Close thread"
          onClick={onClose}
          // Opening a thread moves focus into it, so Escape closes it.
          autoFocus
        >
          <Icon name="x" />
        </button>
      </header>
      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
        </div>
      )}
      <ChatLog
        key={thread.toolUseId}
        rows={rows}
        actions={actions}
        expanded={expanded}
        initial={START}
        onScrollState={NOOP}
        hasMore={false}
        loading={false}
        onLoadOlder={NOOP}
        label={`Subagent thread: ${thread.title}`}
        testId="thread-log"
        empty={
          <div className="logempty">
            {loaded ? 'This subagent has no items yet.' : 'Loading the thread'}
          </div>
        }
      />
    </aside>
  );
}
