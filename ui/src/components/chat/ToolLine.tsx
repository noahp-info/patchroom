import { useMemo } from 'react';
import type { ToolItem } from '../../ipc';
import { diffOf } from '../../lib/diff';
import { inputText, TOOL_STATE_LABEL, toolLabel, toolSummary } from '../../lib/tools';
import { Icon } from '../Icon';
import { ChatImage } from './ChatImage';
import { DiffTable } from './DiffTable';

export interface ToolLineProps {
  item: ToolItem;
  expanded: boolean;
  onToggle(): void;
}

/** One bordered line per tool call. It expands to the input, the result and, for edits, the diff. */
export function ToolLine({ item, expanded, onToggle }: ToolLineProps) {
  const diff = useMemo(
    () =>
      item.name === 'Edit' || item.name === 'Write' || item.name === 'MultiEdit'
        ? diffOf(item)
        : null,
    [item],
  );
  const summary = toolSummary(item.name, item.input);
  const bodyId = `tool-${item.key}`;
  return (
    <div className="toolbox" data-state={item.state} data-testid="tool">
      <button
        type="button"
        className="tool"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={onToggle}
        title={summary || undefined}
      >
        <span className={`tstate ${item.state}`} aria-hidden="true">
          {item.state === 'ok' ? (
            <Icon name="check" />
          ) : item.state === 'error' || item.state === 'denied' ? (
            <Icon name="x" />
          ) : null}
        </span>
        <span className="tn">{toolLabel(item.name)}</span>
        <code className="tsum">{summary}</code>
        {diff && (
          <span className="tdiff">
            <span className="add">+{diff.added}</span>{' '}
            <span className="del">&minus;{diff.removed}</span>
          </span>
        )}
        <span className={`tst ${item.state}`}>
          {item.state === 'ok' ? '' : TOOL_STATE_LABEL[item.state]}
        </span>
        <span className={`tchev${expanded ? ' open' : ''}`} aria-hidden="true">
          <Icon name="chev" />
        </span>
      </button>
      {expanded && (
        <div className="tool-body" id={bodyId}>
          {diff ? (
            <DiffTable diff={diff} />
          ) : (
            <>
              <div className="tl">Input</div>
              <pre className="tpre" tabIndex={0}>
                {inputText(item.name, item.input)}
              </pre>
              {item.inputTruncated && <div className="tnote">Input truncated.</div>}
            </>
          )}
          {item.result ? (
            <>
              <div className="tl">{item.result.isError ? 'Error' : 'Result'}</div>
              <pre className={`tpre${item.result.isError ? ' err' : ''}`} tabIndex={0}>
                {item.result.text || '(empty)'}
              </pre>
              {item.result.images && item.result.images.length > 0 && (
                <div className="chatimgs">
                  {item.result.images.map((im) => (
                    <ChatImage key={im.ref} image={im} />
                  ))}
                </div>
              )}
              {item.result.truncated && (
                <div className="tnote">Output truncated. Open the terminal for the full text.</div>
              )}
            </>
          ) : (
            <div className="tnote">No result yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
