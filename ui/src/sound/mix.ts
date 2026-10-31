import {
  cleanGain,
  DEFAULT_PACK,
  type MixChoice,
  type Prefs,
  type SoundEvent,
} from '../components/prefs/ipc.ts';

/**
 * What one event plays. The DM's own setting for that event wins, then the DM's pack, then the
 * global mix, then Patch Tones. A DM's own entry carries its own gain. A DM pack with no entry
 * for the event keeps the global gain of that event.
 */
export function resolveChoice(event: SoundEvent, sound: Prefs['sound'], dmId?: string): MixChoice {
  const dm = dmId ? sound.perDm[dmId] : undefined;
  if (dm && typeof dm === 'object') {
    const own = dm.mix?.[event];
    if (own) return own;
    if (dm.pack) return withGain({ pack: dm.pack }, choiceGain(sound.mix[event] ?? 'off', 1));
  }
  return sound.mix[event] ?? { pack: DEFAULT_PACK };
}

/** The event gain a choice carries (0 to 1.5). `fallback` when it has none; an Off choice has 0. */
export function choiceGain(c: MixChoice, fallback = 1): number {
  return isOff(c) ? fallback : (cleanGain(c.gain) ?? fallback);
}

/** The same source at another gain. Gain 1 is stored as no gain. Off has no gain to set. */
export function withGain(c: MixChoice, gain: number): MixChoice {
  if (isOff(c)) return c;
  const { gain: _drop, ...src } = c;
  void _drop;
  const g = cleanGain(gain) ?? 1;
  return g === 1 ? (src as MixChoice) : ({ ...src, gain: g } as MixChoice);
}

/** Changing the source keeps the event's volume. Off has none to keep. */
export function keepGain(next: MixChoice, prev: MixChoice | undefined): MixChoice {
  return prev === undefined ? next : withGain(next, choiceGain(prev));
}

export const isOff = (c: MixChoice): c is 'off' => c === 'off';
export const isCustom = (c: MixChoice): c is { custom: string; gain?: number } =>
  typeof c === 'object' && 'custom' in c;
export const isPack = (c: MixChoice): c is { pack: string; gain?: number } =>
  typeof c === 'object' && 'pack' in c;

/** A stable string for comparing two choices (select values, cache keys). */
export function choiceKey(c: MixChoice): string {
  if (isOff(c)) return 'off';
  return isCustom(c) ? `custom:${c.custom}` : `pack:${c.pack}`;
}

export function parseChoiceKey(k: string): MixChoice {
  if (k === 'off') return 'off';
  if (k.startsWith('custom:')) return { custom: k.slice(7) };
  return { pack: k.startsWith('pack:') ? k.slice(5) : k };
}
