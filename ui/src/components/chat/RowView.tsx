import { memo, useState } from 'react';
import type { ChatItem, MarkKind, PromptAnswer, SubagentItem } from '../../ipc';
import { emojiName } from '../../lib/emoji';
import { EmojiPicker } from '../EmojiPicker';
import type { Row } from '../../lib/rows';
import { systemLabel } from '../../lib/systemLabel';
import { Markdown } from '../../lib/markdown';
import { formatClock } from '../../lib/time';
import type { AppStore } from '../../state/store';
import { ClaudeGlyph, Icon } from '../Icon';
import { AskWidget } from './AskWidget';
import { ChatImage } from './ChatImage';
import { ToolLine } from './ToolLine';

/** What a row needs from the surrounding chat. Stable across renders. */
export interface RowActions {
  store: AppStore;
  sessionId: string;
  toggle(key: string): void;
  openThread(item: SubagentItem): void;
  showTerminal(): void;
  /** "Answer in terminal": hand the prompt to the TUI and show the terminal. */
  handoff(promptId: string): void;
  answer(promptId: string, answer: PromptAnswer): void;
  /** Pin, save or react; a second call with the same arguments removes the mark. */
  toggleMark(itemKey: string, kind: MarkKind, emoji?: string): void;
  /** Copy the item's text. Resolves false when the clipboard refused. */
  copy(item: ChatItem): Promise<boolean>;
}

/** What marks and highlights the row carries. Identity is stable while nothing changes. */
export interface Decor {
  /** A search or jump landed here. */
  hit: boolean;
  /** A comment line in the composer quotes this row. */
  commented?: boolean;
  pinned: boolean;
  saved: boolean;
  /** Reaction emoji on this item. A reaction is a label only. */
  reactions: string[];
}

function HoverBar({
  item,
  decor,
  actions,
}: {
  item: ChatItem;
  decor?: Decor;
  actions: RowActions;
}) {
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const [copied, setCopied] = useState(false);
  const pinned = decor?.pinned ?? false;
  const saved = decor?.saved ?? false;
  return (
    <div className="hbar" role="toolbar" aria-label="Message actions">
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy'}
        title="Copy"
        onClick={() =>
          void actions.copy(item).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          })
        }
      >
        <Icon name="copy" />
      </button>
      <button
        type="button"
        aria-label="React"
        title="Add a reaction"
        aria-haspopup="dialog"
        aria-expanded={picker !== null}
        onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}
      >
        <Icon name="smile" />
      </button>
      <button
        type="button"
        aria-label={pinned ? 'Unpin' : 'Pin'}
        title={pinned ? 'Unpin from this DM' : 'Pin to this DM'}
        aria-pressed={pinned}
        onClick={() => actions.toggleMark(item.key, 'pin')}
      >
        <Icon name="pin" />
      </button>
      <button
        type="button"
        aria-label={saved ? 'Remove from Saved' : 'Save'}
        title={saved ? 'Remove from Saved items' : 'Save for later'}
        aria-pressed={saved}
        onClick={() => actions.toggleMark(item.key, 'saved')}
      >
        <Icon name="bookmark" />
      </button>
      {picker && (
        <EmojiPicker
          anchor={picker}
          onPick={(e) => actions.toggleMark(item.key, 'reaction', e)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function Marks({ item, decor, actions }: { item: ChatItem; decor?: Decor; actions: RowActions }) {
  if (!decor || (!decor.pinned && !decor.saved && decor.reactions.length === 0)) return null;
  return (
    <div className="mrk" data-testid="marks">
      {decor.pinned && (
        <span className="mtag" data-mark="pin">
          <Icon name="pin" />
          Pinned
        </span>
      )}
      {decor.saved && (
        <span className="mtag" data-mark="saved">
          <Icon name="bookmark" />
          Saved
        </span>
      )}
      {decor.reactions.map((e) => (
        <button
          key={e}
          type="button"
          className="rchip"
          data-emoji={e}
          aria-label={`Reaction :${emojiName(e)}:. Click to remove.`}
          title={`:${emojiName(e)}:`}
          onClick={() => actions.toggleMark(item.key, 'reaction', e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

function Who({ author, ms }: { author: 'user' | 'claude'; ms: number }) {
  return (
    <>
      <div className={`av ${author === 'claude' ? 'bot' : 'user'}`} aria-hidden="true">
        {author === 'claude' ? <ClaudeGlyph /> : <span>You</span>}
      </div>
      <div className="who">
        <b>{author === 'claude' ? 'Claude' : 'You'}</b>
        <time>{formatClock(ms)}</time>
      </div>
    </>
  );
}

function questionStateText(item: Extract<ChatItem, { kind: 'question' }>): string {
  switch (item.state) {
    case 'declined':
      return 'Declined';
    case 'interrupted':
      return 'Interrupted';
    case 'answered':
      return 'Answered';
    case 'pending':
      return 'Waiting for an answer';
    default:
      return item.answers ? 'Answered' : 'Waiting for an answer';
  }
}

function planStateText(state: string): string {
  switch (state) {
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'interrupted':
      return 'Interrupted';
    case 'pending':
      return 'Waiting for approval';
    default:
      return state.charAt(0).toUpperCase() + state.slice(1);
  }
}

function Thinking({ text, open, onToggle }: { text: string; open: boolean; onToggle(): void }) {
  const has = text.trim() !== '';
  return (
    <div className="thinking">
      <button
        type="button"
        className="think-btn"
        aria-expanded={has ? open : undefined}
        disabled={!has}
        onClick={onToggle}
      >
        <span className={`tchev${open ? ' open' : ''}`} aria-hidden="true">
          <Icon name="chev" />
        </span>
        Thinking
      </button>
      {open && has && <div className="think-text">{text}</div>}
    </div>
  );
}

function SubagentLine({ item, onOpen }: { item: SubagentItem; onOpen(): void }) {
  const running = item.state === 'running';
  return (
    <button
      type="button"
      className="thread"
      onClick={onOpen}
      data-testid="subagent"
      aria-label={`Open subagent thread: ${item.description}`}
    >
      <span className="stack" aria-hidden="true">
        <span>
          <ClaudeGlyph />
        </span>
        <span>
          <ClaudeGlyph />
        </span>
      </span>
      <span className="thread-text">
        <span className="thread-name">Subagent: {item.description}</span>
        <span className="tx">
          {item.agentType} &middot; {item.itemCount} {item.itemCount === 1 ? 'item' : 'items'}{' '}
          &middot; {running ? 'running' : item.state === 'ok' ? 'done' : item.state}
        </span>
      </span>
      <span className="thread-open">Open thread</span>
    </button>
  );
}

function ItemBody({
  item,
  expanded,
  prompt,
  actions,
}: {
  item: ChatItem;
  expanded: boolean;
  prompt: Extract<Row, { type: 'item' }>['prompt'];
  actions: RowActions;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="body">
          {item.text && <UserText text={item.text} />}
          {item.images.length > 0 && (
            <div className="chatimgs">
              {item.images.map((im) => (
                <ChatImage key={im.ref} image={im} />
              ))}
            </div>
          )}
        </div>
      );
    case 'assistant':
      return (
        <div className="body">
          <Markdown text={item.text} />
        </div>
      );
    case 'thinking':
      return (
        <div className="body">
          <Thinking text={item.text} open={expanded} onToggle={() => actions.toggle(item.key)} />
        </div>
      );
    case 'tool':
      return (
        <div className="body">
          <ToolLine item={item} expanded={expanded} onToggle={() => actions.toggle(item.key)} />
        </div>
      );
    case 'subagent':
      return (
        <div className="body">
          <SubagentLine item={item} onOpen={() => actions.openThread(item)} />
        </div>
      );
    case 'question':
      return (
        <div className="body">
          {prompt ? (
            <AskWidget
              prompt={prompt}
              questions={item.questions}
              onAnswer={(a) => actions.answer(prompt.promptId, a)}
              onTerminal={() => actions.handoff(prompt.promptId)}
            />
          ) : (
            <div
              className="ask"
              data-kind="question"
              data-state="resolved"
              role="group"
              aria-label="Question asked"
            >
              <div className="ask-h">
                <span className="ask-title">Claude asked</span>
                <span className="ask-done">{questionStateText(item)}</span>
              </div>
              {item.state === 'pending' && (
                <div className="ask-f">
                  <span className="hint">Waiting for an answer. The terminal has the picker.</span>
                  <button type="button" className="btn sec" onClick={actions.showTerminal}>
                    Open terminal
                  </button>
                </div>
              )}
              <ul className="qdone">
                {item.questions.map((q) => (
                  <li key={q.question}>
                    <span className="qdone-q">{q.question}</span>
                    {item.answers?.[q.question] && (
                      <span className="qdone-a">{item.answers[q.question]}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      );
    case 'plan':
      return (
        <div className="body">
          {prompt ? (
            <AskWidget
              prompt={prompt}
              plan={item.plan}
              onAnswer={(a) => actions.answer(prompt.promptId, a)}
              onTerminal={() => actions.handoff(prompt.promptId)}
            />
          ) : (
            <div
              className="ask"
              data-kind="plan"
              data-state="resolved"
              role="group"
              aria-label="Plan"
            >
              <div className="ask-h">
                <span className="ask-title">Claude&apos;s plan</span>
                <span className="ask-done">{planStateText(item.state)}</span>
              </div>
              <div className="ask-plan" tabIndex={0}>
                <Markdown text={item.plan} />
              </div>
            </div>
          )}
        </div>
      );
    case 'system':
      return (
        <div className="body sys" data-subtype={item.subtype}>
          <span className="sys-line">
            <span className="sys-sub">{systemLabel(item.subtype)}</span>
            {item.text && <span className="sys-text">{item.text}</span>}
          </span>
        </div>
      );
    case 'fallback':
      return (
        <div className="body fb" data-line-type={item.lineType}>
          <span className="fb-line">
            <span className="fb-type">{item.lineType}</span>
            <span className="fb-sum">{item.summary}</span>
            <button type="button" className="fb-btn" onClick={actions.showTerminal}>
              View in terminal
            </button>
          </span>
        </div>
      );
  }
}

/** A sent message. Highlight-to-comment quotes ("> ...") show as quotes, the rest as typed. */
function UserText({ text }: { text: string }) {
  const blocks: { quote: boolean; lines: string[] }[] = [];
  for (const line of text.split('\n')) {
    const quote = /^>( |$)/.test(line);
    const last = blocks.at(-1);
    const body = quote ? line.replace(/^> ?/, '') : line;
    if (last && last.quote === quote) last.lines.push(body);
    else blocks.push({ quote, lines: [body] });
  }
  if (!blocks.some((b) => b.quote)) return <p className="usertext">{text}</p>;
  return (
    <div className="usertext">
      {blocks.map((b, i) =>
        b.quote ? (
          <blockquote key={i} className="uq">
            {b.lines.join('\n')}
          </blockquote>
        ) : (
          // A blank line between a quote and its note is spacing, not text.
          <p key={i}>{b.lines.join('\n').replace(/^\n+|\n+$/g, '')}</p>
        ),
      )}
    </div>
  );
}

export interface RowViewProps {
  row: Row;
  expanded: boolean;
  actions: RowActions;
  decor?: Decor;
}

/** Items that get a hover bar. System lines and terminal fallbacks are not messages. */
const MARKABLE = new Set<ChatItem['kind']>(['user', 'assistant', 'plan', 'question', 'tool']);

function RowViewInner({ row, expanded, actions, decor }: RowViewProps) {
  if (row.type === 'day') {
    return (
      <div className="day" role="separator" aria-label={row.label}>
        {row.label}
      </div>
    );
  }
  if (row.type === 'prompt') {
    return (
      <div className={`msg bot${row.head ? ' head' : ' cont'}`} data-kind="prompt">
        {row.head && <Who author="claude" ms={row.ms} />}
        <div className="body">
          <AskWidget
            prompt={row.prompt}
            onAnswer={(a) => actions.answer(row.prompt.promptId, a)}
            onTerminal={() => actions.handoff(row.prompt.promptId)}
          />
        </div>
      </div>
    );
  }
  const { item } = row;
  const author = row.author;
  return (
    <div
      className={`msg ${author === 'user' ? 'user' : author === 'claude' ? 'bot' : 'plain'}${row.head ? ' head' : ' cont'}`}
      data-kind={item.kind}
      data-key={item.key}
      data-hit={decor?.hit ? 'true' : undefined}
      data-commented={decor?.commented ? 'true' : undefined}
    >
      {row.head && author !== 'none' && <Who author={author} ms={row.ms} />}
      <ItemBody item={item} expanded={expanded} prompt={row.prompt} actions={actions} />
      <Marks item={item} decor={decor} actions={actions} />
      {MARKABLE.has(item.kind) && <HoverBar item={item} decor={decor} actions={actions} />}
    </div>
  );
}

export const RowView = memo(
  RowViewInner,
  (a, b) =>
    a.expanded === b.expanded &&
    a.actions === b.actions &&
    a.decor === b.decor &&
    a.row.key === b.row.key &&
    a.row.type === b.row.type &&
    (a.row.type === 'item' && b.row.type === 'item'
      ? a.row.item === b.row.item && a.row.head === b.row.head && a.row.prompt === b.row.prompt
      : a.row.type === 'prompt' && b.row.type === 'prompt'
        ? a.row.prompt === b.row.prompt && a.row.head === b.row.head
        : a.row.type === 'day' && b.row.type === 'day'
          ? a.row.label === b.row.label
          : false),
);
