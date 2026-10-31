import {
  SOUND_EVENTS,
  type HookDetect,
  type Prefs,
  type SoundEvent,
} from '../components/prefs/ipc.ts';
import { dndActive } from './dnd.ts';
import { isOff, resolveChoice } from './mix.ts';

export type SoundSkip =
  'disabled' | 'event-off' | 'volume-zero' | 'dnd' | 'dm-muted' | 'mix-off' | 'hook-keep';

export type SoundDecision = { play: true } | { play: false; reason: SoundSkip };

/** Which Patchroom events a Claude hook event stands in for. Others have no Patchroom twin. */
const HOOK_TO_EVENTS: Record<string, SoundEvent[]> = {
  Stop: ['done'],
  SubagentStop: ['done'],
  TaskCompleted: ['done'],
  Notification: ['needs'],
  PermissionRequest: ['needs'],
  StopFailure: ['error'],
  SessionStart: ['session'],
  PostToolUseFailure: ['error'],
};

/** The Patchroom events one detected hook event overlaps. */
export function eventsForHook(hookEvent: string): SoundEvent[] {
  if ((SOUND_EVENTS as readonly string[]).includes(hookEvent)) return [hookEvent as SoundEvent];
  return HOOK_TO_EVENTS[hookEvent] ?? [];
}

/** The user's own hooks already play audio for this event and the policy is "Keep yours". */
export function hookKeepsEvent(
  event: SoundEvent,
  detected: readonly HookDetect[],
  policy: Prefs['sound']['hookPolicy'],
): boolean {
  return detected.some(
    (h) =>
      !h.guarded &&
      eventsForHook(h.event).includes(event) &&
      (policy[h.event] ?? 'keep') === 'keep',
  );
}

export interface DecideContext {
  dmId?: string;
  now?: Date;
  /** A test button: skip DND, mutes and hook policy. */
  force?: boolean;
}

/** Pure decision for one sound. The order is also the order of the reasons a user would check. */
export function decideSound(
  event: SoundEvent,
  prefs: Prefs,
  detected: readonly HookDetect[],
  ctx: DecideContext = {},
): SoundDecision {
  const s = prefs.sound;
  if (ctx.force) return { play: true };
  if (!s.enabled) return { play: false, reason: 'disabled' };
  if (!(s.perEvent[event]?.on ?? true)) return { play: false, reason: 'event-off' };
  if (s.volume <= 0) return { play: false, reason: 'volume-zero' };
  if (dndActive(prefs.dnd, ctx.now)) return { play: false, reason: 'dnd' };
  if (ctx.dmId && s.perDm[ctx.dmId] === 'mute') return { play: false, reason: 'dm-muted' };
  if (isOff(resolveChoice(event, s, ctx.dmId))) return { play: false, reason: 'mix-off' };
  if (hookKeepsEvent(event, detected, s.hookPolicy)) return { play: false, reason: 'hook-keep' };
  return { play: true };
}
