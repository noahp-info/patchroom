import type { MarkInfo, SessionInfo } from '../ipc';
import { formatStamp, toMillis } from '../lib/time';
import { artifactUrlFor } from '../lib/artifacts';
import { emojiName } from '../lib/emoji';
import type { AppStore } from '../state/store';
import { Icon } from './Icon';

/** Pins of one DM or saved items across DMs. Each row jumps to its message. */
export function MarkList({
  marks,
  sessions,
  store,
  showDm,
  empty,
  onJump,
  testId,
}: {
  marks: MarkInfo[];
  sessions: SessionInfo[];
  store: AppStore;
  showDm: boolean;
  empty: string;
  onJump?(): void;
  testId: string;
}) {
  if (marks.length === 0) return <p className="listempty">{empty}</p>;
  const name = (id: string) => sessions.find((s) => s.id === id)?.name ?? 'Deleted DM';
  return (
    <ul className="marklist" data-testid={testId}>
      {marks.map((m) => {
        const artifact = m.kind === 'pin' ? artifactUrlFor(m.conversationId, m.itemKey) : null;
        return (
          <li
            key={m.id}
            className="markrow"
            data-item={m.itemKey}
            data-dm={m.conversationId}
            data-artifact={artifact ? 'true' : undefined}
          >
            <button
              type="button"
              className="markrow__main"
              onClick={() => {
                onJump?.();
                store.openDm(m.conversationId, { itemKey: m.itemKey });
              }}
            >
              <span className="markrow__meta">
                {showDm && <b>{name(m.conversationId)}</b>}
                {m.createdAt !== undefined && <time>{formatStamp(toMillis(m.createdAt))}</time>}
                {m.kind === 'reaction' && m.emoji && (
                  <span title={`:${emojiName(m.emoji)}:`}>{m.emoji}</span>
                )}
                {artifact && <span className="markrow__tag">Artifact</span>}
              </span>
              <span className="markrow__text">{m.snapshot || 'Message'}</span>
            </button>
            {artifact && (
              <button
                type="button"
                className="markrow__open"
                data-testid="artifact-open"
                title={artifact}
                onClick={() => {
                  onJump?.();
                  store.openLink(artifact);
                }}
              >
                Open
              </button>
            )}
            <button
              type="button"
              className="markrow__x"
              aria-label={`Remove ${m.kind === 'pin' ? 'pin' : 'saved item'}`}
              title={m.kind === 'pin' ? 'Unpin' : 'Remove from Saved'}
              onClick={() =>
                void store.toggleMark(m.conversationId, m.itemKey, m.kind, m.emoji ?? undefined)
              }
            >
              <Icon name="x" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
