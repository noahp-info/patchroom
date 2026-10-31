import { useMemo, useState } from 'react';
import type { EmojiFlavor } from '../ipc';
import { EMOJI, pushRecent, readRecent } from '../lib/emoji';
import { lastFlavor, rememberFlavor } from './Emoji';
import { Floating, type Anchor } from './Floating';

const FLAVORS: { id: EmojiFlavor; label: string }[] = [
  { id: 'apple', label: 'Apple' },
  { id: 'noto', label: 'Noto' },
];

export interface EmojiPickerProps {
  anchor: Anchor;
  /** `flavor` is the style chosen in the picker (always `apple` without `flavors`). */
  onPick(emoji: string, flavor: EmojiFlavor): void;
  /** Offer the Apple or Noto style, like a skin tone: the pick carries it. Names use this. */
  flavors?: boolean;
  /** The style to start on, for an emoji that already has one. */
  flavor?: EmojiFlavor;
  /** Portal target inside a modal dialog. */
  container?: HTMLElement | null;
  onClose(): void;
  /** Accessible name of the dialog. Defaults to the reaction wording. */
  label?: string;
  /** When set, the picker offers "No emoji", which calls this. */
  onClear?(): void;
}

/** Emoji picker for reactions: a search box, the recent emoji, then the full set. */
export function EmojiPicker({
  anchor,
  onPick,
  onClose,
  label = 'Add a reaction',
  onClear,
  flavors = false,
  flavor: startFlavor,
  container,
}: EmojiPickerProps) {
  const [q, setQ] = useState('');
  const [flavor, setFlavor] = useState<EmojiFlavor>(() =>
    flavors ? (startFlavor ?? lastFlavor()) : 'apple',
  );
  const [recent] = useState(readRecent);
  const term = q.trim().toLowerCase().replace(/^:|:$/g, '');
  const shown = useMemo(
    () =>
      term === ''
        ? EMOJI
        : EMOJI.filter((x) => x.name.includes(term) || (x.kw ?? '').includes(term)),
    [term],
  );

  const pick = (e: string) => {
    pushRecent(e);
    if (flavors) rememberFlavor(flavor);
    onPick(e, flavor);
    onClose();
  };

  const cell = (e: string, name: string, key: string) => (
    <button
      key={key}
      type="button"
      className="emoji emo"
      data-flavor={flavor}
      title={`:${name}:`}
      aria-label={`:${name}:`}
      data-emoji={e}
      onClick={() => pick(e)}
    >
      {e}
    </button>
  );

  return (
    <Floating
      anchor={anchor}
      onClose={onClose}
      label={label}
      className="picker"
      container={container}
    >
      <input
        className="picker__q"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown[0]) {
            e.preventDefault();
            pick(shown[0].e);
          }
        }}
        placeholder="Find an emoji"
        aria-label="Find an emoji"
        autoFocus
      />
      {flavors && (
        <div className="picker__flavor" role="radiogroup" aria-label="Emoji style">
          <span className="picker__flavor-l" aria-hidden="true">
            Style
          </span>
          {FLAVORS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={flavor === f.id}
              className="picker__flavor-opt"
              data-testid={`emoji-flavor-${f.id}`}
              onClick={() => setFlavor(f.id)}
            >
              <span className="emo" data-flavor={f.id} aria-hidden="true">
                {'\u{1F600}'}
              </span>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {onClear && (
        <button
          type="button"
          className="picker__clear"
          data-testid="emoji-clear"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          No emoji
        </button>
      )}
      {term === '' && recent.length > 0 && (
        <div className="picker__sec" data-testid="emoji-recent">
          <h3>Recent</h3>
          <div className="picker__grid">
            {recent.map((e) => cell(e, EMOJI.find((x) => x.e === e)?.name ?? e, `r-${e}`))}
          </div>
        </div>
      )}
      <div className="picker__sec">
        <h3>{term === '' ? 'All emoji' : 'Results'}</h3>
        <div className="picker__grid">{shown.map((x) => cell(x.e, x.name, x.name))}</div>
        {shown.length === 0 && <p className="picker__none">No emoji match.</p>}
      </div>
    </Floating>
  );
}
