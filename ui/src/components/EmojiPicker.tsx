import { useMemo, useState } from 'react';
import { EMOJI, pushRecent, readRecent } from '../lib/emoji';
import { Floating, type Anchor } from './Floating';

export interface EmojiPickerProps {
  anchor: Anchor;
  onPick(emoji: string): void;
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
}: EmojiPickerProps) {
  const [q, setQ] = useState('');
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
    onPick(e);
    onClose();
  };

  const cell = (e: string, name: string, key: string) => (
    <button
      key={key}
      type="button"
      className="emoji"
      title={`:${name}:`}
      aria-label={`:${name}:`}
      data-emoji={e}
      onClick={() => pick(e)}
    >
      {e}
    </button>
  );

  return (
    <Floating anchor={anchor} onClose={onClose} label={label} className="picker">
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
