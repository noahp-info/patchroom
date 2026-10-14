import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import type { ChatModel, ChatNotice } from '../../state/chat';
import type { SendResultKind } from '../../state/store';
import { Icon } from '../Icon';

export interface ComposerProps {
  model: ChatModel;
  name: string;
  /** The session is running a turn: Stop is shown. */
  busy: boolean;
  /** The process ended: the box is disabled. */
  ended: boolean;
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
}

const MAX_HEIGHT = 200;

/** Composer: Enter sends, Shift+Enter adds a line, text reaches claude exactly as typed. */
export function Composer({
  model,
  name,
  busy,
  ended,
  readOnly = null,
  blocked = false,
  notice = null,
  onSend,
  onOpenTerminal,
  onBlocked,
  onStop,
  onPasteImage,
}: ComposerProps) {
  const [text, setText] = useState(model.draft);
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

  const send = useCallback(() => {
    if (off || text.trim() === '') return;
    // A dialog only the terminal can answer is up: writing now would answer it by accident.
    if (blocked) {
      onBlocked?.();
      return;
    }
    const sent = text;
    setText('');
    model.setDraft('');
    void Promise.resolve(onSend(sent)).then((r) => {
      if (r !== 'blocked_dialog' && r !== 'mirror_readonly' && r !== 'error') return;
      // Not sent: the draft comes back, ahead of anything typed meanwhile.
      const next = model.draft ? `${sent}\n${model.draft}` : sent;
      setText(next);
      model.setDraft(next);
    });
  }, [off, text, blocked, onBlocked, onSend, model]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
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
      <div className="box" data-readonly={readOnly ? 'true' : undefined}>
        <textarea
          ref={box}
          className="input"
          rows={1}
          value={text}
          disabled={off}
          placeholder={
            ended
              ? 'This session has ended. Resume it to keep talking.'
              : readOnly
                ? readOnly
                : `Message ${name}`
          }
          aria-label={`Message ${name}`}
          data-testid="composer-input"
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
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
          <span className="hint-keys">Enter sends. Shift+Enter adds a line.</span>
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
            disabled={off || text.trim() === ''}
            onClick={send}
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );
}
