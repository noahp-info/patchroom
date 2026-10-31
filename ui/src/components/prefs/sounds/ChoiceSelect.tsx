import { choiceKey, parseChoiceKey } from '../../../sound/mix.ts';
import { customLabel } from '../../../sound/catalog.ts';
import type { MixChoice, PackInfo, SoundEvent } from '../ipc.ts';

const FILE = '__file';
const INHERIT = '__inherit';

export interface ChoiceSelectProps {
  event: SoundEvent;
  packs: PackInfo[];
  names: Record<string, string>;
  /** The current choice. Undefined with `inheritLabel` set means "no choice of its own". */
  value: MixChoice | undefined;
  label: string;
  /** Adds a first option for "no choice of my own" (per-DM rows). */
  inheritLabel?: string;
  disabled?: boolean;
  onChange(choice: MixChoice | undefined): void;
  /** "Your file..." was picked. */
  onPickFile(): void;
}

/** One event's source: any pack's sound for it, the user's file, or Off. */
export function ChoiceSelect(p: ChoiceSelectProps) {
  const has = p.packs.filter((k) => k.events[p.event]);
  const custom = p.value && typeof p.value === 'object' && 'custom' in p.value ? p.value : null;
  return (
    <select
      aria-label={p.label}
      disabled={p.disabled}
      value={p.value === undefined ? INHERIT : choiceKey(p.value)}
      onChange={(e) => {
        const v = e.target.value;
        if (v === FILE) p.onPickFile();
        else if (v === INHERIT) p.onChange(undefined);
        else p.onChange(parseChoiceKey(v));
      }}
    >
      {p.inheritLabel && <option value={INHERIT}>{p.inheritLabel}</option>}
      {has.map((k) => (
        <option key={k.id} value={`pack:${k.id}`}>
          {k.name}
        </option>
      ))}
      {p.value &&
        typeof p.value === 'object' &&
        'pack' in p.value &&
        !has.some((k) => k.id === (p.value as { pack: string }).pack) && (
          <option value={choiceKey(p.value)}>{(p.value as { pack: string }).pack} (missing)</option>
        )}
      {custom && (
        <option value={`custom:${custom.custom}`}>{customLabel(p.names, custom.custom)}</option>
      )}
      <option value={FILE}>Your file...</option>
      <option value="off">Off</option>
    </select>
  );
}
