export interface Emoji {
  /** The character stored as the reaction label. */
  e: string;
  /** Slack-style shortcode without colons. */
  name: string;
  /** Extra search words. */
  kw?: string;
}

export const EMOJI: readonly Emoji[] = [
  { e: '✅', name: 'white_check_mark', kw: 'done yes ok check' },
  { e: '\u{1F44D}', name: '+1', kw: 'thumbsup like approve' },
  { e: '\u{1F44E}', name: '-1', kw: 'thumbsdown dislike' },
  { e: '\u{1F440}', name: 'eyes', kw: 'looking watch review' },
  { e: '\u{1F389}', name: 'tada', kw: 'party celebrate' },
  { e: '\u{1F680}', name: 'rocket', kw: 'ship launch' },
  { e: '\u{1F525}', name: 'fire', kw: 'hot lit' },
  { e: '❤️', name: 'heart', kw: 'love' },
  { e: '\u{1F64F}', name: 'pray', kw: 'thanks please' },
  { e: '\u{1F4AF}', name: '100', kw: 'perfect' },
  { e: '\u{1F914}', name: 'thinking_face', kw: 'hmm wonder' },
  { e: '\u{1F602}', name: 'joy', kw: 'laugh lol' },
  { e: '\u{1F60D}', name: 'heart_eyes', kw: 'love' },
  { e: '\u{1F62E}', name: 'open_mouth', kw: 'wow surprise' },
  { e: '\u{1F622}', name: 'cry', kw: 'sad' },
  { e: '\u{1F44F}', name: 'clap', kw: 'applause bravo' },
  { e: '\u{1F4AA}', name: 'muscle', kw: 'strong' },
  { e: '\u{1F64C}', name: 'raised_hands', kw: 'hooray' },
  { e: '✨', name: 'sparkles', kw: 'new shiny' },
  { e: '⚠️', name: 'warning', kw: 'careful caution' },
  { e: '❌', name: 'x', kw: 'no wrong cancel' },
  { e: '❓', name: 'question', kw: 'unsure ask' },
  { e: '❗', name: 'exclamation', kw: 'important' },
  { e: '\u{1F41B}', name: 'bug', kw: 'defect' },
  { e: '\u{1F527}', name: 'wrench', kw: 'fix tool' },
  { e: '\u{1F4A1}', name: 'bulb', kw: 'idea' },
  { e: '\u{1F4CC}', name: 'pushpin', kw: 'pin' },
  { e: '\u{1F512}', name: 'lock', kw: 'secure' },
  { e: '⏳', name: 'hourglass_flowing_sand', kw: 'wait later' },
  { e: '\u{1F9EA}', name: 'test_tube', kw: 'test experiment' },
  { e: '\u{1F4DD}', name: 'memo', kw: 'note write' },
  { e: '\u{1F9E0}', name: 'brain', kw: 'smart' },
  { e: '\u{1F916}', name: 'robot_face', kw: 'agent ai' },
  { e: '\u{1F3AF}', name: 'dart', kw: 'target goal' },
  { e: '☕', name: 'coffee', kw: 'break' },
  { e: '\u{1F44B}', name: 'wave', kw: 'hello bye' },
  { e: '\u{1F60E}', name: 'sunglasses', kw: 'cool' },
  { e: '\u{1F605}', name: 'sweat_smile', kw: 'phew' },
  { e: '\u{1F4E6}', name: 'package', kw: 'release' },
  { e: '\u{1F6D1}', name: 'octagonal_sign', kw: 'stop' },
];

export function emojiName(e: string): string {
  return EMOJI.find((x) => x.e === e)?.name ?? e;
}

const RECENT_KEY = 'patchroom.recentEmoji';
const MAX_RECENT = 8;

export function readRecent(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

export function pushRecent(e: string): string[] {
  const next = [e, ...readRecent().filter((x) => x !== e)].slice(0, MAX_RECENT);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recents are a convenience.
  }
  return next;
}
