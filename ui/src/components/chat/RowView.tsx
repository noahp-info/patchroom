import { memo } from 'react';
import type { ChatItem, PromptAnswer, SubagentItem } from '../../ipc';
import type { Row } from '../../lib/rows';
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
          {item.text && <p className="usertext">{item.text}</p>}
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
            <span className="sys-sub">{item.subtype.replace(/_/g, ' ')}</span>
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

export interface RowViewProps {
  row: Row;
  expanded: boolean;
  actions: RowActions;
}

function RowViewInner({ row, expanded, actions }: RowViewProps) {
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
    >
      {row.head && author !== 'none' && <Who author={author} ms={row.ms} />}
      <ItemBody item={item} expanded={expanded} prompt={row.prompt} actions={actions} />
    </div>
  );
}

export const RowView = memo(
  RowViewInner,
  (a, b) =>
    a.expanded === b.expanded &&
    a.actions === b.actions &&
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
