/**
 * Dictation in the composer: where words go, which shortcut starts it, and what each error
 * says. Pure, so tests import it directly. The live run is `state/dictation.ts`.
 */

/** Shortcuts Settings > Dictation offers. None clash with the app's own; Fn Fn is macOS's. */
export const DICTATION_SHORTCUTS = [
  { id: 'cmd-shift-d', label: '⌘⇧D' },
  { id: 'ctrl-cmd-d', label: '⌃⌘D' },
  { id: 'cmd-shift-period', label: '⌘⇧.' },
  { id: 'off', label: 'None' },
] as const;
export type DictationShortcut = (typeof DICTATION_SHORTCUTS)[number]['id'];

export interface DictationPrefs {
  enabled: boolean;
  /** Locale id, or empty for the system language. */
  locale: string;
  shortcut: DictationShortcut;
  silenceSecs: number;
}

export const DEFAULT_DICTATION: DictationPrefs = {
  enabled: true,
  locale: '',
  shortcut: 'cmd-shift-d',
  silenceSecs: 8,
};

export const SILENCE_CHOICES = [4, 8, 15, 30] as const;

export function dictationPrefs(raw: Partial<DictationPrefs> | null | undefined): DictationPrefs {
  return { ...DEFAULT_DICTATION, ...(raw ?? {}) };
}

export function shortcutLabel(id: DictationShortcut | string): string {
  return DICTATION_SHORTCUTS.find((s) => s.id === id)?.label ?? '';
}

/** Does this key press match the chosen shortcut? */
export function matchesShortcut(e: KeyboardEvent, id: DictationShortcut | string): boolean {
  if (e.altKey || e.repeat) return false;
  const k = e.key.toLowerCase();
  const [meta, shift, ctrl] = [!!e.metaKey, !!e.shiftKey, !!e.ctrlKey];
  switch (id) {
    case 'cmd-shift-d':
      return meta && shift && !ctrl && (k === 'd' || e.code === 'KeyD');
    case 'ctrl-cmd-d':
      return meta && ctrl && !shift && (k === 'd' || e.code === 'KeyD');
    case 'cmd-shift-period':
      return meta && shift && !ctrl && (e.code === 'Period' || k === '.' || k === '>');
    default:
      return false;
  }
}

/** Where dictated words land: the draft around them and the words heard so far. */
export interface Anchor {
  before: string;
  after: string;
  /** Words already committed into `before` from this utterance (after the person typed). */
  skip: string;
}

/** Start an anchor at the caret. A selection is replaced by the first words. */
export function anchorAt(text: string, start: number, end: number): Anchor {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { before: text.slice(0, s), after: text.slice(e), skip: '' };
}

/** The part of a cumulative transcript that is new since `skip`. */
function fresh(heard: string, skip: string): string {
  if (!skip) return heard;
  return heard.startsWith(skip) ? heard.slice(skip.length).trimStart() : heard;
}

/**
 * The draft with `heard` placed at the anchor, spaced from its neighbours, and the caret right
 * after it. Each partial replaces the previous one; the final text replaces the partials.
 */
export function placeWords(a: Anchor, heard: string): { text: string; caret: number } {
  let words = fresh(heard, a.skip).trim();
  if (words && a.before && !/\s$/.test(a.before)) words = ` ${words}`;
  if (words && a.after && !/^\s/.test(a.after)) words = `${words} `;
  const head = a.before + words;
  return { text: head + a.after, caret: head.length };
}

/** Error codes from the helper (`patchroom-dictation` protocol). */
export type DictationErrorCode =
  | 'speech_denied'
  | 'speech_restricted'
  | 'mic_denied'
  | 'mic_restricted'
  | 'on_device_unavailable'
  | 'audio'
  | 'recognizer'
  | 'helper_missing'
  | 'unknown';

/** A System Settings pane `dictation_open_settings` may open. */
export type SettingsPane = 'microphone' | 'speech' | 'dictation';

/** What the composer shows for an error, and the button that fixes it. */
export function errorView(
  code: DictationErrorCode | string,
  language: string,
): { text: string; action?: { label: string; pane: SettingsPane } } {
  switch (code) {
    case 'speech_denied':
      return {
        text: 'Speech Recognition is off for Patchroom. Turn it on to dictate.',
        action: { label: 'Open Privacy settings', pane: 'speech' },
      };
    case 'speech_restricted':
      return {
        text: 'Speech Recognition is restricted on this Mac, so dictation is off.',
        action: { label: 'Open Privacy settings', pane: 'speech' },
      };
    case 'mic_denied':
      return {
        text: 'Microphone access is off for Patchroom. Turn it on to dictate.',
        action: { label: 'Open Microphone settings', pane: 'microphone' },
      };
    case 'mic_restricted':
      return {
        text: 'The microphone is restricted on this Mac, so dictation is off.',
        action: { label: 'Open Microphone settings', pane: 'microphone' },
      };
    case 'on_device_unavailable':
      return {
        text: `On-device dictation isn’t available for ${language || 'this language'}. Download it in Keyboard settings.`,
        action: { label: 'Open Keyboard settings', pane: 'dictation' },
      };
    case 'audio':
      return { text: 'No microphone is available. Connect one and try again.' };
    case 'helper_missing':
      return { text: 'Dictation isn’t part of this build.' };
    default:
      return { text: 'Dictation stopped unexpectedly. Try again.' };
  }
}
