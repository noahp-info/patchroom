import { useRef, useState, type FocusEvent, type FormEvent } from 'react';
import { EmojiPicker } from './EmojiPicker';
import { Icon } from './Icon';

/** A small button that shows the chosen emoji and opens the picker the reactions use. */
export function EmojiButton({
  emoji,
  onPick,
  onClear,
  onToggle,
}: {
  emoji: string | null;
  onPick(emoji: string): void;
  onClear?(): void;
  /** Called as the picker opens and closes, so a parent can hold focus rules while it is up. */
  onToggle?(open: boolean): void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const close = () => {
    setRect(null);
    onToggle?.(false);
  };
  return (
    <>
      <button
        type="button"
        className="sec-emoji-btn"
        aria-label={emoji ? `Emoji ${emoji}. Change it` : 'Choose an emoji'}
        aria-haspopup="dialog"
        aria-expanded={rect !== null}
        data-testid="sec-emoji-btn"
        onClick={(e) => {
          if (rect) return close();
          setRect(e.currentTarget.getBoundingClientRect());
          onToggle?.(true);
        }}
      >
        {emoji ? <span aria-hidden="true">{emoji}</span> : <Icon name="smile" />}
      </button>
      {rect && (
        <EmojiPicker
          anchor={rect}
          label="Section emoji"
          onPick={onPick}
          onClear={emoji ? onClear : undefined}
          onClose={close}
        />
      )}
    </>
  );
}

/** The create row under the header: a name (a label for a divider) and an optional emoji. */
export function AddForm({
  mode,
  onSubmit,
  onCancel,
}: {
  mode: 'section' | 'divider';
  onSubmit(name: string, emoji: string | null): void;
  onCancel(): void;
}) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const divider = mode === 'divider';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(name, emoji);
  };
  return (
    <form className="side-add" onSubmit={submit} data-testid={`add-${mode}`}>
      <EmojiButton emoji={emoji} onPick={setEmoji} onClear={() => setEmoji(null)} />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={divider ? 'Divider label (optional)' : 'Section name'}
        aria-label={divider ? 'Divider label' : 'Section name'}
        autoFocus
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
      <button type="submit" className="btn sec" disabled={!divider && name.trim() === ''}>
        Add
      </button>
    </form>
  );
}

/**
 * Inline rename in place of a header. Enter or leaving the row saves, Escape cancels. The emoji
 * button saves its pick at once and hands focus back to the name, so the row stays open.
 */
export function RenameForm({
  name,
  emoji,
  divider,
  onCommit,
  onEmoji,
  onCancel,
}: {
  name: string;
  emoji: string | null;
  divider: boolean;
  onCommit(name: string): void;
  onEmoji(emoji: string | null): void;
  onCancel(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const picking = useRef(false);
  const done = useRef(false);
  const label = divider ? 'Divider label' : 'Section name';
  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(input.current?.value ?? name);
  };
  const leave = (e: FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (picking.current || (to && form.current?.contains(to))) return;
    commit();
  };
  return (
    <form
      ref={form}
      className="sec-h sec-edit"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
      onBlur={leave}
    >
      <EmojiButton
        emoji={emoji}
        onPick={(e) => {
          onEmoji(e);
          input.current?.focus();
        }}
        onClear={() => {
          onEmoji(null);
          input.current?.focus();
        }}
        onToggle={(open) => {
          picking.current = open;
          if (!open) input.current?.focus();
        }}
      />
      <input
        ref={input}
        name="name"
        defaultValue={name}
        placeholder={divider ? 'Divider label (optional)' : undefined}
        aria-label={label}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          done.current = true;
          onCancel();
        }}
      />
    </form>
  );
}
