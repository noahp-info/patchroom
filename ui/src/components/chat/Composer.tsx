import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { shellQuotePath } from '../../lib/keys';
import type { ChatModel } from '../../state/chat';
import { Icon } from '../Icon';

export interface ComposerProps {
  model: ChatModel;
  name: string;
  /** The session is running a turn: Stop is shown. */
  busy: boolean;
  /** The process ended: the box is disabled. */
  ended: boolean;
  onSend(text: string): void;
  onStop(): void;
  /** Ctrl+V to the PTY so claude reads an image off the system clipboard. */
  onPasteImage(): void;
}

const MAX_HEIGHT = 200;

/** Composer: Enter sends, Shift+Enter adds a line, text reaches claude exactly as typed. */
export function Composer({
  model,
  name,
  busy,
  ended,
  onSend,
  onStop,
  onPasteImage,
}: ComposerProps) {
  const [text, setText] = useState(model.draft);
  const [images, setImages] = useState(0);
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

  const send = useCallback(() => {
    if (ended || text.trim() === '') return;
    onSend(text);
    setText('');
    model.setDraft('');
    setImages(0);
  }, [ended, text, onSend, model]);

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
    if (files.length === 0) return;
    const paths = files
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p && p.startsWith('/'));
    if (paths.length > 0) {
      // A real file on disk: paste its absolute path, which claude attaches as an image.
      e.preventDefault();
      model.insertIntoDraft(paths.map(shellQuotePath).join(' ') + ' ');
      return;
    }
    if (data.getData('text/plain')) return;
    // A clipboard bitmap has no path. claude reads it from the system clipboard on Ctrl+V.
    e.preventDefault();
    onPasteImage();
    setImages((n) => n + files.length);
  };

  const slash = () => {
    if (!text.startsWith('/')) setText((t) => `/${t}`);
    box.current?.focus();
  };

  return (
    <div className="composer" data-testid="composer">
      <div className="box">
        {images > 0 && (
          <div className="queued" role="status">
            <span className="qc">
              {images === 1
                ? '1 image attached from the clipboard'
                : `${images} images attached from the clipboard`}
            </span>
          </div>
        )}
        <textarea
          ref={box}
          className="input"
          rows={1}
          value={text}
          disabled={ended}
          placeholder={
            ended ? 'This session has ended. Resume it to keep talking.' : `Message ${name}`
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
            disabled={ended}
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
            disabled={ended || text.trim() === ''}
            onClick={send}
          >
            <Icon name="send" />
          </button>
        </div>
      </div>
    </div>
  );
}
