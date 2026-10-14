import type { HookDetect, SoundEvent } from '../components/prefs/ipc.ts';
import { getPrefsStore } from '../components/prefs/store.ts';
import { decideSound, type SoundDecision } from './decide.ts';
import { synth } from './pack.ts';

export { dndActive, dndSummary, scheduleActive } from './dnd.ts';
export { decideSound, eventsForHook, hookKeepsEvent } from './decide.ts';
export type { SoundDecision, SoundSkip } from './decide.ts';
export { PACK } from './pack.ts';

export interface PlaySoundOpts {
  /** The DM the event belongs to, for the per-DM mute. */
  dmId?: string;
  /** A test button: always play, ignoring DND, mutes and hook policy. */
  force?: boolean;
  /** Override the clock (tests). */
  now?: Date;
  /** Override the detected hooks (tests). Defaults to the last `sound_hooks_detect`. */
  detected?: readonly HookDetect[];
}

export interface SoundLogEntry {
  event: SoundEvent;
  dmId?: string;
  decision: SoundDecision;
  at: number;
}

/** Every decision, newest last. Read by tests and by the judge when the screen is locked. */
export const soundLog: SoundLogEntry[] = [];

/**
 * Play the pack sound for an event if prefs, Do Not Disturb, the DM mute and the user's own
 * sound hooks allow it. Returns the decision either way.
 */
export function playSound(event: SoundEvent, opts: PlaySoundOpts = {}): SoundDecision {
  const store = getPrefsStore();
  const prefs = store.getPrefs();
  const decision = decideSound(event, prefs, opts.detected ?? store.getDetected(), {
    dmId: opts.dmId,
    now: opts.now,
    force: opts.force,
  });
  soundLog.push({ event, dmId: opts.dmId, decision, at: Date.now() });
  if (soundLog.length > 200) soundLog.shift();
  if (decision.play) synth(event, opts.force && prefs.sound.volume <= 0 ? 0.6 : prefs.sound.volume);
  return decision;
}
