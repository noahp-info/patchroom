import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionInfo, TerminalWait } from '../../ipc';
import { Icon } from '../Icon';

/** Where a mirrored session runs, for labels. Empty when the backend did not say. */
export function mirrorWhere(s: Pick<SessionInfo, 'mirror'>): string {
  return s.mirror?.where?.trim() || '';
}

export interface MirrorBannerProps {
  session: SessionInfo;
  /** "Move here": resume it as soon as the other copy closes. */
  onArm(enabled: boolean): void;
  /** Bring the other terminal to the front. Resolves to the failure text, or null. */
  onReveal(): Promise<string | null>;
  /** The user confirmed: stop the idle other copy and resume here. Refusal text, or null. */
  onEnd(): Promise<string | null>;
}

/** Hosts with no window of their own to bring forward. */
const NO_WINDOW = new Set(['tmux', 'zellij', 'another terminal']);

/**
 * The session runs in another terminal. Patchroom shows its transcript read-only and never
 * starts a second process. "Move here" resumes it once that copy closes; "Show in <where>"
 * brings that tab forward; "End in <where>" (confirmed, idle only) closes that copy for you.
 */
export function MirrorBanner({ session, onArm, onReveal, onEnd }: MirrorBannerProps) {
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'confirm' | 'ending'>('idle');
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The safe choice holds focus while the confirm is open, so Enter never ends it by accident.
  useEffect(() => {
    if (mode !== 'confirm') return;
    const raf = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [mode]);
  const m = session.mirror;
  if (!m) return null;
  const where = mirrorWhere(session);
  const host = where || 'the other terminal';
  const armed = !!m.takeoverWhenClosed;
  const canReveal = !!where && !NO_WINDOW.has(where) && !!m.pid;
  const idle = session.status === 'idle';

  let detail: ReactNode;
  if (mode === 'ending') detail = `Ending it in ${host}…`;
  else if (mode === 'confirm')
    detail = `Text typed there but not sent is lost. The conversation is saved and continues here.`;
  else if (note) detail = note;
  else if (armed)
    detail = (
      <>
        Close it in {host} (<code>/exit</code> or Ctrl+C twice). It opens here as soon as it closes.
      </>
    );
  else detail = 'Read-only here. Patchroom never runs two copies of one session.';

  return (
    <div
      className={`mbanner${mode === 'confirm' ? ' mbanner--confirm' : ''}`}
      role="status"
      data-testid="mirror-banner"
    >
      <Icon name="lock" />
      <div className="mbanner__text">
        <b>
          {mode === 'confirm'
            ? `End the Claude session running in ${host}?`
            : `Open in another terminal${where ? ` (${where})` : ''}`}
        </b>
        <span
          data-testid="mirror-detail"
          className={note && mode === 'idle' ? 'mbanner__note' : undefined}
        >
          {detail}
        </span>
      </div>
      <div className="mbanner__actions">
        {mode === 'confirm' ? (
          <>
            <button
              type="button"
              className="mbanner__btn"
              data-testid="end-cancel"
              ref={cancelRef}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMode('idle');
              }}
              onClick={() => setMode('idle')}
            >
              Cancel
            </button>
            <button
              type="button"
              className="mbanner__btn mbanner__btn--danger-solid"
              data-testid="end-confirm"
              onClick={() => {
                setMode('ending');
                setNote(null);
                void onEnd().then((err) => {
                  setNote(err);
                  setMode('idle');
                });
              }}
            >
              End it and move here
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`mbanner__btn${armed ? '' : ' mbanner__btn--primary'}`}
              data-testid="move-here"
              aria-pressed={armed}
              disabled={mode === 'ending'}
              onClick={() => {
                setNote(null);
                onArm(!armed);
              }}
            >
              {armed ? 'Cancel move' : 'Move here'}
            </button>
            {canReveal && (
              <button
                type="button"
                className="mbanner__btn mbanner__btn--quiet"
                data-testid="show-in-terminal"
                disabled={mode === 'ending'}
                onClick={() => {
                  void onReveal().then(setNote);
                }}
              >
                Show in {where}
              </button>
            )}
            <button
              type="button"
              className="mbanner__btn mbanner__btn--danger"
              data-testid="end-in-terminal"
              disabled={!idle || mode === 'ending' || !m.pid}
              title={
                !m.pid
                  ? `Can't tell which process runs it. Close it in ${host}.`
                  : idle
                    ? `Close the copy in ${host} for you, then continue here`
                    : `Busy in ${host}. Wait until it finishes.`
              }
              onClick={() => {
                setNote(null);
                setMode('confirm');
              }}
            >
              End in {where || 'terminal'}…
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export interface TerminalWaitBannerProps {
  wait: TerminalWait;
  onShowTerminal(): void;
}

/** Claude waits on a dialog only the terminal can show. One key flips to it. */
export function TerminalWaitBanner({ wait, onShowTerminal }: TerminalWaitBannerProps) {
  const detail = wait.reason && wait.reason !== 'dialog open' ? wait.reason : null;
  return (
    <div className="tbanner" role="alert" data-testid="terminal-wait-banner">
      <Icon name="term" />
      <div className="tbanner__text">
        <b>Claude is showing something in the terminal</b>
        <span>
          {detail ? `${detail}. ` : ''}Answer it there. A message you type stays in the box until
          you send it again.
        </span>
      </div>
      <button
        type="button"
        className="tbanner__btn"
        data-testid="open-terminal"
        onClick={onShowTerminal}
      >
        Show terminal <kbd>{'⌘J'}</kbd>
      </button>
    </div>
  );
}
