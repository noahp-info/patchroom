import { useState } from 'react';
import type { SessionInfo, TerminalWait } from '../../ipc';
import { Icon } from '../Icon';

/** Where a mirrored session runs, for labels. Empty when the backend did not say. */
export function mirrorWhere(s: Pick<SessionInfo, 'mirror'>): string {
  return s.mirror?.where?.trim() || '';
}

export interface MirrorBannerProps {
  session: SessionInfo;
  /** "Take over when it closes". */
  onArm(enabled: boolean): void;
  /** Resume now. Resolves to the backend's refusal, or null once the session is ours. */
  onTakeoverNow(): Promise<string | null>;
}

/**
 * The session runs in another terminal. Patchroom shows its transcript read-only and never
 * starts a second process. "Take over when it closes" resumes it once that process exits.
 */
export function MirrorBanner({ session, onArm, onTakeoverNow }: MirrorBannerProps) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const m = session.mirror;
  if (!m) return null;
  const where = mirrorWhere(session);
  const armed = !!m.takeoverWhenClosed;
  return (
    <div className="mbanner" role="status" data-testid="mirror-banner">
      <Icon name="lock" />
      <div className="mbanner__text">
        <b>Open in another terminal{where ? ` (${where})` : ''}</b>
        <span data-testid="mirror-detail">
          {refusal ?? 'Read-only here. Patchroom never starts a second copy of a session.'}
        </span>
      </div>
      <button
        type="button"
        className="mbanner__btn"
        data-testid="take-over-when-closed"
        aria-pressed={armed}
        onClick={() => onArm(!armed)}
      >
        {armed && <Icon name="check" />}
        Take over when it closes
      </button>
      <button
        type="button"
        className="mbanner__btn mbanner__btn--quiet"
        data-testid="take-over-now"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onTakeoverNow().then((err) => {
            setRefusal(err);
            setBusy(false);
          });
        }}
      >
        Take over now
      </button>
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
          {detail ? `${detail}. ` : ''}Answer it there. Messages you send wait until it closes.
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
