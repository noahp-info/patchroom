import {
  DEFAULT_PACK,
  type MixChoice,
  type Prefs,
  type SoundEvent,
} from '../components/prefs/ipc.ts';

/**
 * What one event plays. The DM's own setting for that event wins, then the DM's pack, then the
 * global mix, then Patch Tones.
 */
export function resolveChoice(event: SoundEvent, sound: Prefs['sound'], dmId?: string): MixChoice {
  const dm = dmId ? sound.perDm[dmId] : undefined;
  if (dm && typeof dm === 'object') {
    const own = dm.mix?.[event];
    if (own) return own;
    if (dm.pack) return { pack: dm.pack };
  }
  return sound.mix[event] ?? { pack: DEFAULT_PACK };
}

export const isOff = (c: MixChoice): c is 'off' => c === 'off';
export const isCustom = (c: MixChoice): c is { custom: string } =>
  typeof c === 'object' && 'custom' in c;
export const isPack = (c: MixChoice): c is { pack: string } => typeof c === 'object' && 'pack' in c;

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
