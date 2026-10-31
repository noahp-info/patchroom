import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import type { ChatModel, ChatNotice } from '../../state/chat';
import type { SendResultKind } from '../../state/store';
import { composeMessage, type DraftComment } from '../../lib/comments';
import {
  anchorAt,
  errorView,
  matchesShortcut,
  placeWords,
  shortcutLabel,
  type Anchor,
  type DictationPrefs,
} from '../../lib/dictation';
import type { DictationController, DictationSnapshot } from '../../state/dictation';
import { Icon } from '../Icon';

/** On-device dictation for this composer. Absent: no mic button. */
export interface ComposerDictation {
  controller: DictationController;
  /** The DM this composer writes to (the run's owner). */
  owner: string;
  prefs: DictationPrefs;
  /** This composer is on screen: it takes the shortcut. */
  active: boolean;
  /** A run ended with words heard (the first-time hint). */
  onUsed?(): void;
}

export interface ComposerProps {
  model: ChatModel;
  name: string;
  /** The session is running a turn: Stop is shown. */
  busy: boolean;
  /** The process ended: the box is disabled. */
  ended: boolean;
  /** Restart an ended session. When set, clicking the ended box resumes it. */
  onResume?(): void;
  /** Why the box is read-only (a mirror of a session open elsewhere); null when it is not. */
  readOnly?: string | null;
  /** A terminal-only dialog is up: Enter keeps the draft and shows why instead of sending. */
  blocked?: boolean;
  /** The line under the log about the last send. */
  notice?: ChatNotice | null;
  onSend(text: string): Promise<SendResultKind> | void;
  /** Show the terminal (the notice's "Open terminal"). */
  onOpenTerminal?(): void;
  /** Enter was pressed while `blocked`. */
  onBlocked?(): void;
  onStop(): void;
  /** Save a pasted image; its absolute path lands in the draft. */
  onPasteImage(file: Blob): Promise<void> | void;
  /** Start screenshot-to-steer (Cmd+Shift+2). */
  onShot?(): void;
  /** A side-pane comment line's jump back. */
  onRevealLink?(link: string, quote: string): void;
  dictation?: ComposerDictation;
}

const MAX_HEIGHT = 200;

const IDLE_DICTATION: DictationSnapshot = { phase: 'idle', owner: null, error: null, notice: null };

/** Composer: Enter sends, Shift+Enter adds a line, text reaches claude exactly as typed. */
export function Composer({
  model,
  name,
  busy,
  ended,
  onResume,
  readOnly = null,
  blocked = false,
  notice = null,
  onSend,
  onOpenTerminal,
  onBlocked,
  onStop,
  onPasteImage,
  onShot,
  onRevealLink,
  dictation,
}: ComposerProps) {
  const [text, setText] = useState(model.draft);
  const { comments } = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const box = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLTextAreaElement>(null);

  // Drafts live in the model so switching DMs keeps them.
  useEffect(() => {
    model.setDraft(text);
  }, [model, text]);

  useEffect(() => {
    return model.onDraft(() => setText(model.draft));
  }, [model]);

  // Size the box from a hidden twin, never from the box itself. Collapsing the real box to
  // measure it would, for one layout pass, give the log above it more room and clamp its scroll
  // position, which reads as the user scrolling up.
  useLayoutEffect(() => {
    const el = box.current;
    const twin = mirror.current;
    if (!el || !twin) return;
    el.style.height = `${Math.min(MAX_HEIGHT, twin.scrollHeight)}px`;
  }, [text]);

  const off = ended || !!readOnly;

  // ---- dictation ----------------------------------------------------------------------------
  const ctl = dictation?.controller ?? null;
  const noRun = useCallback(() => () => undefined, []);
  const dsnap = useSyncExternalStore(
    ctl?.subscribe ?? noRun,
    ctl?.getSnapshot ?? (() => IDLE_DICTATION),
  );
  const owner = dictation?.owner ?? '';
  const dictOn = !!dictation?.prefs.enabled && !off;
  const phase = dsnap.owner === owner && owner ? dsnap.phase : 'idle';
  const listening = phase !== 'idle';
  const anchor = useRef<Anchor | null>(null);
  const lastHeard = useRef('');
  const caret = useRef<number | null>(null);
  const usedRef = useRef(dictation?.onUsed);
  useLayoutEffect(() => {
    usedRef.current = dictation?.onUsed;
  });

  const startDictation = useCallback(() => {
    if (!ctl || !dictation) return;
    const el = box.current;
    const cur = el?.value ?? '';
    anchor.current = anchorAt(
      cur,
      el?.selectionStart ?? cur.length,
      el?.selectionEnd ?? cur.length,
    );
    lastHeard.current = '';
    el?.focus();
    void ctl.start(
      owner,
      { locale: dictation.prefs.locale, silenceSecs: dictation.prefs.silenceSecs },
      {
        onWords(heard, final) {
          const a = anchor.current;
          if (!a) return;
          const placed = placeWords(a, heard);
          lastHeard.current = heard;
          caret.current = placed.caret;
          setText(placed.text);
          if (final) {
            // Settled words stay; anything heard after this is a new utterance.
            anchor.current = anchorAt(placed.text, placed.caret, placed.caret);
            lastHeard.current = '';
          }
        },
        onEnd(_reason, heard) {
          anchor.current = null;
          lastHeard.current = '';
          if (heard) usedRef.current?.();
        },
      },
    );
  }, [ctl, dictation, owner]);

  const stopDictation = useCallback(() => ctl?.stop(), [ctl]);
  const toggleDictation = useCallback(() => {
    if (listening) stopDictation();
    else startDictation();
  }, [listening, startDictation, stopDictation]);

  // The caret follows the dictated words.
  useLayoutEffect(() => {
    const at = caret.current;
    const el = box.current;
    if (at === null || !el) return;
    caret.current = null;
    el.setSelectionRange(at, at);
  }, [text]);

  // The shortcut starts and stops dictation in the composer on screen.
  const shortcut = dictation?.prefs.shortcut ?? 'off';
  const active = !!dictation?.active;
  useEffect(() => {
    if (!dictOn || !active || shortcut === 'off') return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!matchesShortcut(e, shortcut)) return;
      // A dialog (Settings, New session) owns the keyboard.
      if (!listening && document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      toggleDictation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dictOn, active, shortcut, listening, toggleDictation]);

  // While listening: Esc anywhere stops, and so does leaving the window or the DM.
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      stopDictation();
    };
    const onBlur = () => stopDictation();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [listening, stopDictation]);
  useEffect(() => {
    if (listening && (!active || off)) stopDictation();
  }, [listening, active, off, stopDictation]);
  // Leaving (another DM, the chat closed) ends this composer's own run, never another's.
  useEffect(
    () => () => {
      if (ctl && owner && ctl.getSnapshot().owner === owner) ctl.stop();
    },
    [ctl, owner],
  );

  const dictError = dsnap.error?.owner === owner && owner ? dsnap.error : null;
  const dictNotice = dsnap.notice?.owner === owner && owner ? dsnap.notice : null;
  const errView = dictError ? errorView(dictError.code, dictError.language) : null;
  const keyLabel = shortcutLabel(shortcut);
  const placeholder = ended
    ? 'This session has ended. Resume it to keep talking.'
    : readOnly
      ? readOnly
      : `Message ${name}`;

  const empty = text.trim() === '' && comments.length === 0;

  const send = useCallback(() => {
    if (off || empty) return;
    // Never send mid-dictation: Enter finishes the words first, and the next Enter sends.
    if (listening) {
      stopDictation();
      return;
    }
    // A dialog only the terminal can answer is up: writing now would answer it by accident.
    if (blocked) {
      onBlocked?.();
      return;
    }
    const sent = text;
    const lines = model.takeComments();
    setText('');
    model.setDraft('');
    void Promise.resolve(onSend(composeMessage(lines, sent))).then((r) => {
      if (r !== 'blocked_dialog' && r !== 'mirror_readonly' && r !== 'error') return;
      // Not sent: the draft and its comment lines come back, ahead of anything added meanwhile.
      model.restoreComments(lines);
      if (sent.trim() === '') return;
      const next = model.draft ? `${sent}\n${model.draft}` : sent;
      setText(next);
      model.setDraft(next);
    });
  }, [off, empty, text, blocked, onBlocked, onSend, model, listening, stopDictation]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && listening) {
      e.preventDefault();
      stopDictation();
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault();
      onStop();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    const files = Array.from(data.files).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0 || data.getData('text/plain')) return;
    // A clipboard bitmap has no path. Save it and put the saved path in the draft.
    e.preventDefault();
    for (const f of files) void onPasteImage(f);
  };

  const slash = () => {
    if (!text.startsWith('/')) setText((t) => `/${t}`);
    box.current?.focus();
  };

  return (
    <div className="composer" data-testid="composer">
      {notice && (
        <div
          className="cnotice"
          role="status"
          data-testid="composer-notice"
          data-kind={notice.kind}
        >
          <span>{notice.text}</span>
          {(notice.kind === 'blocked' || notice.kind === 'no-echo') && onOpenTerminal && (
            <button type="button" className="cnotice__btn" onClick={onOpenTerminal}>
              Open terminal
            </button>
          )}
        </div>
      )}
      {(errView || dictNotice) && (
        <div
          className="cnotice cnotice--dict"
          role={errView ? 'alert' : 'status'}
          data-testid="dictation-notice"
          data-kind={errView ? 'dict-error' : 'dict-note'}
          data-code={dictError?.code}
        >
          <span>{errView?.text ?? dictNotice?.text}</span>
          {errView?.action && (
            <button
              type="button"
              className="btn sec"
              data-testid="dictation-settings"
              onClick={() => ctl?.openSettings(errView.action!.pane)}
            >
              {errView.action.label}
            </button>
          )}
          <button
            type="button"
            className="ib"
            aria-label="Dismiss"
            title="Dismiss"
            data-testid="dictation-dismiss"
            onClick={() => ctl?.dismiss(owner)}
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      {(readOnly || (ended && !onResume)) && (
        <div className="cnotice cnotice--reason" role="status" data-testid="composer-reason">
          <span>
            {readOnly
              ? text.trim() !== ''
                ? `${readOnly}. Your draft stays here and is not sent.`
                : `${readOnly}. Nothing you type here is sent.`
              : 'This session has ended. Resume it to send.'}
          </span>
        </div>
      )}
      <div
        className="box"
        data-readonly={readOnly ? 'true' : undefined}
        data-dictating={listening ? phase : undefined}
      >
        {ended && !readOnly && onResume && (
          <button
            type="button"
            className="box__resume"
            data-testid="composer-resume"
            onClick={onResume}
          >
            <Icon name="resume" />
            This session has ended. Click here to resume it.
            {text.trim() !== '' && <span>Your draft is kept.</span>}
          </button>
        )}
        {comments.length > 0 && (
          <ul className="clines" aria-label="Comments to send" data-testid="comment-lines">
            {comments.map((c) => (
              <CommentLine
                key={c.id}
                comment={c}
                model={model}
                onReveal={onRevealLink}
                onSubmit={send}
                onDone={() => box.current?.focus()}
              />
            ))}
          </ul>
        )}
        <div className="input-wrap">
          <textarea
            ref={box}
            className="input"
            rows={1}
            value={text}
            disabled={off}
            aria-label={`Message ${name}`}
            aria-placeholder={placeholder}
            data-testid="composer-input"
            spellCheck
            onChange={(e) => {
              const v = e.target.value;
              // Typing while dictating: the words so far stay, new ones land at the caret.
              if (listening && anchor.current) {
                anchor.current = {
                  ...anchorAt(v, e.target.selectionStart, e.target.selectionEnd),
                  skip: lastHeard.current,
                };
              }
              if (dictNotice) ctl?.dismiss(owner);
              setText(v);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {/* Drawn by us, not the native placeholder: WebKit can repaint a cleared field's
              placeholder only where the old text was, which shows a clipped "Mes". */}
          {text === '' && (
            <span className="input-ph" aria-hidden="true" data-testid="composer-placeholder">
              {placeholder}
            </span>
          )}
        </div>
        <textarea
          ref={mirror}
          className="input mirror"
          rows={1}
          value={text}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
        />
        <div className="bar">
          <button
            type="button"
            className="ib"
            aria-label="Slash commands"
            title="Slash commands"
            disabled={off}
            onClick={slash}
          >
            <Icon name="slash" />
          </button>
          {onShot && (
            <button
              type="button"
              className="ib"
              aria-label="Screenshot to steer"
              title={'Point at part of the window with a screenshot (\u2318\u21E72)'}
              data-testid="shot-btn"
              disabled={off}
              onClick={onShot}
            >
              <Icon name="shot" />
            </button>
          )}
          {dictation?.prefs.enabled && (
            <button
              type="button"
              className={`ib dict${listening ? ' dict--on' : ''}`}
              // Listening: the name is the visible text, so speech input can say what it shows.
              aria-label={listening ? undefined : 'Dictate'}
              aria-pressed={listening}
              title={
                listening
                  ? 'Stop dictation (esc)'
                  : `Dictate on this Mac${keyLabel && shortcut !== 'off' ? ` (${keyLabel})` : ''}`
              }
              data-testid="dictate-btn"
              data-phase={phase}
              disabled={off}
              onClick={toggleDictation}
            >
              {listening ? (
                <>
                  <i aria-hidden="true" />
                  <span className="dict__label">
                    {phase === 'starting'
                      ? 'Starting'
                      : phase === 'stopping'
                        ? 'Finishing'
                        : 'Listening'}
                  </span>
                  <kbd>esc</kbd>
                </>
              ) : (
                <Icon name="mic" />
              )}
            </button>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {phase === 'listening'
              ? 'Listening. Press Escape to stop.'
              : phase === 'starting'
                ? 'Starting dictation'
                : phase === 'stopping'
                  ? 'Finishing dictation'
                  : ''}
          </span>
          <span className="hint-keys" data-testid="composer-hint">
            {listening
              ? 'Speak now. Nothing sends until you press Enter.'
              : readOnly
                ? 'Read-only. Sending is off.'
                : ended
                  ? onResume
                    ? 'Ended. Click the box to resume.'
                    : 'Ended. Sending is off.'
                  : blocked
                    ? 'Enter keeps your message here while the terminal is open. Shift+Enter adds a line.'
                    : 'Enter sends. Shift+Enter adds a line.'}
          </span>
          <span className="sp" />
          {busy && (
            <button type="button" className="stop" onClick={onStop} data-testid="stop">
              <i aria-hidden="true" />
              Stop <kbd>esc</kbd>
            </button>
          )}
          <button
            type="button"
            className="send"
            aria-label="Send"
            title="Send (Enter)"
            disabled={off || empty}
            onClick={send}
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** One comment line: the quote (click to jump back), the note, and a remove button. */
function CommentLine({
  comment,
  model,
  onReveal,
  onSubmit,
  onDone,
}: {
  comment: DraftComment;
  model: ChatModel;
  onReveal?(link: string, quote: string): void;
  onSubmit(): void;
  onDone(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (model.claimCommentFocus(comment.id)) input.current?.focus();
  }, [model, comment.id]);
  const first = comment.image ? 'Screenshot' : comment.quote.split('\n')[0];
  const link = comment.link;
  const key = comment.key;
  const jump = key
    ? () => model.jumpTo(key)
    : link && onReveal
      ? () => onReveal(link, comment.quote)
      : null;
  return (
    <li
      className="cline"
      data-testid="comment-line"
      data-key={comment.key ?? undefined}
      data-kind={comment.image ? 'shot' : link ? 'page' : 'chat'}
    >
      {comment.image ? (
        <a
          className="cline__shot"
          href={comment.image.src}
          title={`${comment.image.path}\n\nSent as this file's path`}
          onClick={(e) => e.preventDefault()}
        >
          <img src={comment.image.src} alt="Screenshot to send" data-testid="comment-shot" />
        </a>
      ) : (
        <button
          type="button"
          className="cline__quote"
          title={
            jump
              ? `${comment.quote}\n\nClick to jump to it${link ? ' in the side pane' : ''}`
              : comment.quote
          }
          disabled={!jump}
          data-link={link}
          onClick={() => jump?.()}
        >
          <Icon name={link ? 'ext' : 'chat'} />
          <span>{first}</span>
        </button>
      )}
      <input
        ref={input}
        className="cline__note"
        value={comment.text}
        placeholder={comment.image ? 'Add a note' : 'Add a comment'}
        aria-label={comment.image ? 'Screenshot note' : `Comment on "${first.slice(0, 40)}"`}
        data-testid="comment-note"
        onFocus={() => model.setActiveComment(comment.id)}
        onBlur={() => model.setActiveComment(null)}
        onChange={(e) => model.updateComment(comment.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          } else if (e.key === 'Enter' || e.key === 'Escape') {
            // Enter finishes the note; the message box takes over, nothing is sent.
            e.preventDefault();
            onDone();
          } else if (e.key === 'Backspace' && comment.text === '') {
            e.preventDefault();
            model.removeComment(comment.id);
            onDone();
          }
        }}
      />
      <button
        type="button"
        className="ib cline__x"
        aria-label="Remove comment"
        title="Remove comment"
        onClick={() => model.removeComment(comment.id)}
      >
        <Icon name="x" />
      </button>
    </li>
  );
}
