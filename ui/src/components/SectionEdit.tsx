import { useRef, useState, type FocusEvent, type FormEvent } from 'react';
import type { EmojiFlavor } from '../ipc';
import { Emoji } from './Emoji';
import { EmojiPicker } from './EmojiPicker';
import { Icon } from './Icon';

/**
 * A small button that shows the chosen emoji and opens the picker the reactions use, with the
 * Apple or Noto style choice. Every place a person names something has one.
 */
export function EmojiButton({
  emoji,
  flavor,
  onPick,
  onClear,
  onToggle,
  label = 'Section emoji',
  testId = 'sec-emoji-btn',
  container,
  className = 'sec-emoji-btn',
}: {
  container?: HTMLElement | null;
  className?: string;
  emoji: string | null;
  flavor?: EmojiFlavor | null;
  onPick(emoji: string, flavor: EmojiFlavor): void;
  /** The picker's accessible name. */
  label?: string;
  testId?: string;
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
        className={className}
        aria-label={emoji ? `Emoji ${emoji}. Change it` : 'Choose an emoji'}
        aria-haspopup="dialog"
        aria-expanded={rect !== null}
        data-testid={testId}
        onClick={(e) => {
          if (rect) return close();
          setRect(e.currentTarget.getBoundingClientRect());
          onToggle?.(true);
        }}
      >
        {emoji ? <Emoji char={emoji} flavor={flavor} /> : <Icon name="smile" />}
      </button>
      {rect && (
        <EmojiPicker
          anchor={rect}
          label={label}
          flavors
          flavor={flavor ?? undefined}
          container={container}
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
  onSubmit(name: string, emoji: string | null, flavor: EmojiFlavor): void;
  onCancel(): void;
}) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<{ char: string; flavor: EmojiFlavor } | null>(null);
  const divider = mode === 'divider';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(name, emoji?.char ?? null, emoji?.flavor ?? 'apple');
  };
  return (
    <form className="side-add" onSubmit={submit} data-testid={`add-${mode}`}>
      <EmojiButton
        emoji={emoji?.char ?? null}
        flavor={emoji?.flavor}
        onPick={(char, flavor) => setEmoji({ char, flavor })}
        onClear={() => setEmoji(null)}
      />
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
  flavor,
  divider,
  onCommit,
  onEmoji,
  onCancel,
  label: inputLabel,
  emojiLabel = 'Section emoji',
  className = 'sec-h sec-edit',
}: {
  name: string;
  emoji: string | null;
  flavor?: EmojiFlavor | null;
  divider: boolean;
  onCommit(name: string): void;
  onEmoji(emoji: string | null, flavor: EmojiFlavor): void;
  onCancel(): void;
  /** The name field's accessible name. Default: section or divider wording. */
  label?: string;
  emojiLabel?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const picking = useRef(false);
  const done = useRef(false);
  const label = inputLabel ?? (divider ? 'Divider label' : 'Section name');
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
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
      onBlur={leave}
    >
      <EmojiButton
        emoji={emoji}
        flavor={flavor}
        label={emojiLabel}
        onPick={(e, f) => {
          onEmoji(e, f);
          input.current?.focus();
        }}
        onClear={() => {
          onEmoji(null, 'apple');
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
