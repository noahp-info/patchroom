import { useId, useState } from 'react';
import type { PromptAnswer, QuestionDef } from '../../ipc';
import { Markdown } from '../../lib/markdown';
import { inputText, toolLabel, toolSummary } from '../../lib/tools';
import type { PromptState } from '../../state/chat';

export interface AskProps {
  prompt: PromptState;
  /** Plan text for plan prompts, from the matching plan item or the tool input. */
  plan?: string;
  /** Questions when the matching question item has them but the event did not. */
  questions?: QuestionDef[];
  onAnswer(answer: PromptAnswer): void;
  onTerminal(): void;
}

/** How a prompt ended, in words. */
export function resolutionText(p: PromptState): string | null {
  if (!p.resolved) return null;
  switch (p.resolved.by) {
    case 'terminal':
      return 'Answered in terminal';
    case 'timeout':
      return 'Timed out';
    case 'interrupt':
      return 'Interrupted';
    case 'chat':
      switch (p.answer?.kind) {
        case 'allow':
          return p.kind === 'plan' ? 'Plan approved in chat' : 'Allowed in chat';
        case 'allow_always':
          return 'Always allowed in chat';
        case 'deny':
          return p.kind === 'plan' ? 'Plan revision sent in chat' : 'Denied in chat';
        default:
          return 'Answered in chat';
      }
  }
}

function Footer({
  prompt,
  hint,
  children,
  onTerminal,
}: {
  prompt: PromptState;
  hint: string;
  children: React.ReactNode;
  onTerminal(): void;
}) {
  return (
    <>
      {prompt.error && (
        <div className="ask-err" role="alert">
          {prompt.error}
        </div>
      )}
      {prompt.handedOff ? (
        <div className="ask-f" data-handoff="true">
          <span className="hint">Waiting for your answer in the terminal.</span>
          <button type="button" className="btn sec" onClick={onTerminal}>
            Open terminal
          </button>
        </div>
      ) : (
        <div className="ask-f">
          <span className="hint">{hint}</span>
          <button type="button" className="btn sec" onClick={onTerminal}>
            Answer in terminal
          </button>
          {children}
        </div>
      )}
    </>
  );
}

function Header({ prompt, title }: { prompt: PromptState; title: string }) {
  const done = resolutionText(prompt);
  return (
    <div className="ask-h">
      <span className="ask-title">{title}</span>
      {done ? (
        <span className="ask-done" data-by={prompt.resolved?.by} role="status">
          {done}
        </span>
      ) : (
        <span className="needs-pill">Needs you</span>
      )}
    </div>
  );
}

function PermissionAsk({ prompt, onAnswer, onTerminal }: AskProps) {
  const pending = !prompt.resolved;
  const busy = prompt.sending === true;
  const summary = toolSummary(prompt.toolName, prompt.toolInput);
  return (
    <div
      className="ask"
      data-kind="permission"
      data-state={pending ? 'pending' : 'resolved'}
      role="group"
      aria-label={`Permission request for ${toolLabel(prompt.toolName)}`}
    >
      <Header prompt={prompt} title={`Claude wants to use ${toolLabel(prompt.toolName)}`} />
      <div className="ask-q">{pending ? 'Allow this?' : summary || toolLabel(prompt.toolName)}</div>
      {pending && (
        <pre className="ask-pre" tabIndex={0}>
          {inputText(prompt.toolName, prompt.toolInput)}
        </pre>
      )}
      {pending && (
        <Footer
          prompt={prompt}
          hint="Your answer goes straight back to Claude."
          onTerminal={onTerminal}
        >
          <button
            type="button"
            className="btn sec"
            disabled={busy}
            onClick={() => onAnswer({ kind: 'deny' })}
          >
            Deny
          </button>
          {prompt.canAlways !== false && (
            <button
              type="button"
              className="btn sec"
              disabled={busy}
              title="Applies the rule Claude suggests, like option 2 in the terminal"
              onClick={() => onAnswer({ kind: 'allow_always' })}
            >
              Always allow
            </button>
          )}
          <button
            type="button"
            className="btn pri"
            disabled={busy}
            onClick={() => onAnswer({ kind: 'allow' })}
          >
            Allow
          </button>
        </Footer>
      )}
    </div>
  );
}

const REC = /\s*\(recommended\)\s*$/i;

interface Pick {
  /** Selected option indexes. */
  sel: number[];
  other: boolean;
  text: string;
}

function QuestionBlock({
  q,
  pick,
  onPick,
  disabled,
}: {
  q: QuestionDef;
  pick: Pick;
  onPick(p: Pick): void;
  disabled: boolean;
}) {
  const gid = useId();
  const multi = q.multiSelect === true;
  const type = multi ? 'checkbox' : 'radio';
  const toggle = (i: number) => {
    if (multi) {
      const has = pick.sel.includes(i);
      onPick({ ...pick, sel: has ? pick.sel.filter((x) => x !== i) : [...pick.sel, i] });
    } else onPick({ sel: [i], other: false, text: pick.text });
  };
  return (
    <div className="qblock" role="group" aria-labelledby={`${gid}-q`}>
      <div className="ask-q" id={`${gid}-q`}>
        {q.header && <span className="qhead">{q.header}</span>}
        {q.question}
      </div>
      <ul className="opts">
        {q.options.map((o, i) => {
          const rec = REC.test(o.label);
          const sel = pick.sel.includes(i);
          return (
            <li key={i}>
              <label className={`opt${sel ? ' sel' : ''}`}>
                <input
                  type={type}
                  name={gid}
                  className="opt-input"
                  checked={sel}
                  disabled={disabled}
                  onChange={() => toggle(i)}
                />
                <span className={multi ? 'radio check' : 'radio'} aria-hidden="true" />
                <span className="ol">{o.label.replace(REC, '')}</span>
                {rec ? <span className="rec">Recommended</span> : <span />}
                {o.description && <span className="od">{o.description}</span>}
              </label>
            </li>
          );
        })}
        <li>
          <div className={`other${pick.other ? ' sel' : ''}`}>
            <label className="other-pick">
              <input
                type={type}
                name={gid}
                className="opt-input"
                checked={pick.other}
                aria-label="Other"
                disabled={disabled}
                onChange={() => {
                  if (multi) onPick({ ...pick, other: !pick.other });
                  else onPick({ sel: [], other: true, text: pick.text });
                }}
              />
              <span className={multi ? 'radio check' : 'radio'} aria-hidden="true" />
            </label>
            <input
              type="text"
              className="f"
              value={pick.text}
              disabled={disabled}
              placeholder="Other: describe what you want instead"
              aria-label={`Other answer for: ${q.question}`}
              onChange={(e) =>
                onPick({
                  sel: multi || e.target.value === '' ? pick.sel : [],
                  other: e.target.value !== '' || (multi && pick.other),
                  text: e.target.value,
                })
              }
            />
          </div>
        </li>
      </ul>
    </div>
  );
}

/** Label text for a finished pick, labels joined with ", " for multi-select. */
export function answerFor(q: QuestionDef, pick: Pick): string | null {
  const labels = pick.sel
    .slice()
    .sort((a, b) => a - b)
    .map((i) => q.options[i]?.label.replace(REC, '') ?? '');
  const other = pick.other ? pick.text.trim() : '';
  if (pick.other && other === '') return null;
  if (other) labels.push(other);
  return labels.length ? labels.join(', ') : null;
}

function QuestionAsk({ prompt, questions, onAnswer, onTerminal }: AskProps) {
  const qs = prompt.questions ?? questions ?? [];
  const [picks, setPicks] = useState<Pick[]>(() =>
    qs.map(() => ({ sel: [], other: false, text: '' })),
  );
  const pending = !prompt.resolved;
  const busy = prompt.sending === true;
  const answers = qs.map((q, i) => answerFor(q, picks[i] ?? { sel: [], other: false, text: '' }));
  const ready = answers.length > 0 && answers.every((a) => a !== null);
  const send = () => {
    const out: Record<string, string> = {};
    qs.forEach((q, i) => {
      out[q.question] = answers[i] as string;
    });
    onAnswer({ kind: 'questions', answers: out });
  };
  return (
    <div
      className="ask"
      data-kind="question"
      data-state={pending ? 'pending' : 'resolved'}
      role="group"
      aria-label="Claude is asking"
    >
      <Header prompt={prompt} title="Claude is asking" />
      {pending ? (
        <>
          {qs.map((q, i) => (
            <QuestionBlock
              key={i}
              q={q}
              pick={picks[i] ?? { sel: [], other: false, text: '' }}
              disabled={busy}
              onPick={(p) => setPicks((prev) => prev.map((x, j) => (j === i ? p : x)))}
            />
          ))}
          <Footer
            prompt={prompt}
            hint="Your answer goes straight back to Claude."
            onTerminal={onTerminal}
          >
            <button type="button" className="btn pri" disabled={!ready || busy} onClick={send}>
              Send answer
            </button>
          </Footer>
        </>
      ) : (
        <ul className="qdone">
          {qs.map((q, i) => (
            <li key={i}>
              <span className="qdone-q">{q.question}</span>
              {prompt.answer?.kind === 'questions' && prompt.answer.answers[q.question] ? (
                <span className="qdone-a">{prompt.answer.answers[q.question]}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanAsk({ prompt, plan, onAnswer, onTerminal }: AskProps) {
  const pending = !prompt.resolved;
  const busy = prompt.sending === true;
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const text =
    plan ??
    (typeof prompt.toolInput === 'object' &&
    prompt.toolInput !== null &&
    typeof (prompt.toolInput as { plan?: unknown }).plan === 'string'
      ? (prompt.toolInput as { plan: string }).plan
      : '');
  return (
    <div
      className="ask"
      data-kind="plan"
      data-state={pending ? 'pending' : 'resolved'}
      role="group"
      aria-label="Plan approval"
    >
      <Header prompt={prompt} title="Claude has a plan" />
      <div className="ask-plan" tabIndex={0}>
        <Markdown text={text || '(The plan text is in the terminal.)'} />
      </div>
      {pending && revising && (
        <div className="ask-note">
          <input
            type="text"
            value={note}
            autoFocus
            placeholder="What should change?"
            aria-label="Revision feedback"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && note.trim())
                onAnswer({ kind: 'deny', message: note.trim() });
            }}
          />
          <button
            type="button"
            className="btn sec"
            disabled={!note.trim() || busy}
            onClick={() => onAnswer({ kind: 'deny', message: note.trim() })}
          >
            Send feedback
          </button>
        </div>
      )}
      {pending && (
        <Footer
          prompt={prompt}
          hint="Approving lets Claude start the work."
          onTerminal={onTerminal}
        >
          <button
            type="button"
            className="btn sec"
            disabled={busy}
            aria-expanded={revising}
            onClick={() => setRevising((v) => !v)}
          >
            Revise
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={busy}
            onClick={() => onAnswer({ kind: 'allow' })}
          >
            Approve plan
          </button>
        </Footer>
      )}
    </div>
  );
}

/** The ask widget for one prompt: permission, AskUserQuestion or plan approval. */
export function AskWidget(props: AskProps) {
  switch (props.prompt.kind) {
    case 'permission':
      return <PermissionAsk {...props} />;
    case 'question':
      return <QuestionAsk {...props} />;
    case 'plan':
      return <PlanAsk {...props} />;
  }
}
