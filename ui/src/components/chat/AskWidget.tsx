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
  /** Hand a pending prompt to the terminal (the hook lets go) and show it. */
  onTerminal(): void;
  /** Show the terminal view only, for a prompt that already moved there. */
  onShowTerminal(): void;
}

/** Plain permissions wait this long in chat before the terminal dialog takes over. */
const PERMISSION_WAIT_LABEL = '5 min';

/** How a prompt ended, in words. */
export function resolutionText(p: PromptState): string | null {
  if (!p.resolved) return null;
  switch (p.resolved.by) {
    case 'terminal':
      return 'Answered in terminal';
    case 'timeout':
      return 'Moved to terminal';
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

/**
 * A prompt that timed out in chat is not dead: the terminal dialog still waits. Say so, and
 * offer the way there.
 */
function MovedToTerminal({
  prompt,
  onShowTerminal,
}: {
  prompt: PromptState;
  onShowTerminal(): void;
}) {
  if (prompt.resolved?.by !== 'timeout') return null;
  const why =
    prompt.kind === 'permission'
      ? `Moved to the terminal after ${PERMISSION_WAIT_LABEL}. Claude is waiting for you there.`
      : 'Moved to the terminal. Claude is waiting for you there.';
  return (
    <div className="ask-f" data-moved="terminal">
      <span className="hint">{why}</span>
      <button type="button" className="btn sec" onClick={onShowTerminal}>
        Answer in terminal
      </button>
    </div>
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

function PermissionAsk({ prompt, onAnswer, onTerminal, onShowTerminal }: AskProps) {
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
      <MovedToTerminal prompt={prompt} onShowTerminal={onShowTerminal} />
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

/** The questions of an AskUserQuestion tool input, when the event carried none. */
function questionsOf(input: unknown): QuestionDef[] | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const qs = (input as { questions?: unknown }).questions;
  return Array.isArray(qs) ? (qs as QuestionDef[]) : undefined;
}

/** The plan text of an ExitPlanMode tool input. */
function planOf(input: unknown): string {
  return typeof input === 'object' &&
    input !== null &&
    typeof (input as { plan?: unknown }).plan === 'string'
    ? (input as { plan: string }).plan
    : '';
}

/**
 * Read-only footer for a question or plan that arrived as a plain permission prompt: chat
 * cannot answer it, the terminal picker can.
 */
function TerminalOnly({ prompt, onTerminal }: { prompt: PromptState; onTerminal(): void }) {
  return (
    <Footer
      prompt={prompt}
      hint="This one is answered in the terminal picker."
      onTerminal={onTerminal}
    >
      {null}
    </Footer>
  );
}

function QuestionAsk({
  prompt,
  questions,
  onAnswer,
  onTerminal,
  onShowTerminal,
  terminalOnly,
}: AskProps & { terminalOnly?: boolean }) {
  const qs = prompt.questions ?? questions ?? questionsOf(prompt.toolInput) ?? [];
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
      {pending && terminalOnly ? (
        <>
          <ul className="qdone">
            {qs.map((q, i) => (
              <li key={i}>
                <span className="qdone-q">{q.question}</span>
              </li>
            ))}
          </ul>
          <TerminalOnly prompt={prompt} onTerminal={onTerminal} />
        </>
      ) : pending ? (
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
      <MovedToTerminal prompt={prompt} onShowTerminal={onShowTerminal} />
    </div>
  );
}

function PlanAsk({
  prompt,
  plan,
  onAnswer,
  onTerminal,
  onShowTerminal,
  terminalOnly,
}: AskProps & { terminalOnly?: boolean }) {
  const pending = !prompt.resolved;
  const busy = prompt.sending === true;
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const text = plan ?? planOf(prompt.toolInput);
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
      {pending && terminalOnly && <TerminalOnly prompt={prompt} onTerminal={onTerminal} />}
      {pending && !terminalOnly && (
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
      <MovedToTerminal prompt={prompt} onShowTerminal={onShowTerminal} />
    </div>
  );
}

/** The ask widget for one prompt: permission, AskUserQuestion or plan approval. */
export function AskWidget(props: AskProps) {
  switch (props.prompt.kind) {
    case 'permission':
      // A question or plan never shows as raw tool JSON. The backend sends these as
      // `question` and `plan` prompts; a permission prompt for one (an older backend) is
      // still shown as what it is, answered in the terminal.
      if (props.prompt.toolName === 'AskUserQuestion')
        return <QuestionAsk {...props} terminalOnly />;
      if (props.prompt.toolName === 'ExitPlanMode') return <PlanAsk {...props} terminalOnly />;
      return <PermissionAsk {...props} />;
    case 'question':
      return <QuestionAsk {...props} />;
    case 'plan':
      return <PlanAsk {...props} />;
  }
}
