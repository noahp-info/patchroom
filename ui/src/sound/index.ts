import {
  DEFAULT_PACK,
  type HookDetect,
  type MixChoice,
  type SoundEvent,
} from '../components/prefs/ipc.ts';
import { getPrefsStore } from '../components/prefs/store.ts';
import { decideSound, type SoundDecision } from './decide.ts';
import { playFile } from './files.ts';
import { isCustom, isOff, resolveChoice } from './mix.ts';
import { isGenerated, synth } from './pack.ts';

export { dndActive, dndSummary, scheduleActive } from './dnd.ts';
export { decideSound, eventsForHook, hookKeepsEvent } from './decide.ts';
export type { SoundDecision, SoundSkip } from './decide.ts';
export { EVENT_INFO, GENERATED, PACK } from './pack.ts';
export { resolveChoice } from './mix.ts';

/** File sounds are loudness-matched to the generated ones at this scale of the master volume. */
const FILE_GAIN = 0.8;

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
  /** What the mix resolved to, whether or not it played. */
  choice: MixChoice;
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
  const choice = resolveChoice(event, prefs.sound, opts.dmId);
  soundLog.push({ event, dmId: opts.dmId, decision, choice, at: Date.now() });
  if (soundLog.length > 200) soundLog.shift();
  if (decision.play) {
    const volume = opts.force && prefs.sound.volume <= 0 ? 0.6 : prefs.sound.volume;
    playChoice(choice, event, volume);
  }
  return decision;
}

/** Fires a choice's sound once. Generated packs use the oscillators, everything else a file. */
export function playChoice(choice: MixChoice, event: SoundEvent, volume: number): void {
  if (isOff(choice)) return;
  if (isCustom(choice)) {
    // A custom file that is gone falls back to the default pack's sound for the event.
    void playFile(`custom:${choice.custom}`, event, volume * FILE_GAIN).then((ok) => {
      if (!ok) synth(event, volume, DEFAULT_PACK);
    });
    return;
  }
  if (isGenerated(choice.pack)) {
    synth(event, volume, choice.pack);
    return;
  }
  void playFile(choice.pack, event, volume * FILE_GAIN).then((ok) => {
    if (!ok) synth(event, volume, DEFAULT_PACK);
  });
}

/**
 * Preview one choice from the Sounds pane (a pack card button, a picker test). It ignores every
 * mute and is logged like a forced play.
 */
export function previewChoice(choice: MixChoice, event: SoundEvent): void {
  const prefs = getPrefsStore().getPrefs();
  soundLog.push({ event, decision: { play: true }, choice, at: Date.now() });
  if (soundLog.length > 200) soundLog.shift();
  playChoice(choice, event, prefs.sound.volume <= 0 ? 0.6 : prefs.sound.volume);
}
