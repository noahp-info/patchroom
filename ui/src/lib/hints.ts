import type { PrefsTabId } from './prefsModule';

/**
 * First-time hints (DESIGN.md, First-time hints). Each feature that has a setting a person may
 * not find ships one entry here. A hint shows once, ever, at most one at a time, never blocks
 * and always offers the setting it mentions.
 */
export interface HintDef {
  /** Short and plain: what the person might want, and where it lives. `{name}` style slots. */
  text: string;
  /** The button that opens the setting the hint names. */
  action: { label: string; tab: PrefsTabId };
  /** Extra answers before the settings button, handled by the store (`hintChoice`). */
  choices?: { label: string; choice: string }[];
  /**
   * Where it sits, always in flow: under the conversation header (default), above the status
   * strip next to the model chip, or above the message log's bottom edge.
   */
  place?: 'header' | 'strip' | 'log';
}

export const HINTS = {
  'links.browser': {
    text: 'Want links to always open in your browser? Change it in Settings > Links.',
    action: { label: 'Open Links settings', tab: 'links' },
  },
  'models.bundles': {
    text: 'Switch models from the model chip. Make a bundle of the models you use in Settings > Models.',
    action: { label: 'Open Models settings', tab: 'models' },
    place: 'strip',
  },
  'models.newer': {
    text: '{newer} is out, newer than {model} in your bundle. Swap it in?',
    action: { label: 'Models settings', tab: 'models' },
    choices: [
      { label: 'Swap', choice: 'swap' },
      { label: 'Keep', choice: 'keep' },
    ],
    place: 'strip',
  },
  'models.label': {
    text: 'New model: {model}. Give it a label of its own in Settings > Models.',
    action: { label: 'Set its label', tab: 'models' },
    place: 'strip',
  },
  'scroll.paused': {
    text: 'Auto-scroll paused while you read. Jump to latest, or scroll to the bottom, to turn it back on.',
    action: { label: 'Chat settings', tab: 'themes' },
    place: 'log',
  },
  'emoji.flavor': {
    text: 'Each emoji can be Apple or Noto. Pick how emoji look in chat in Settings > Themes.',
    action: { label: 'Open Themes settings', tab: 'themes' },
  },
  restart: {
    text: 'Patchroom restarted and reopened {count}. Turn on update checks in Settings > Updates.',
    action: { label: 'Open Updates settings', tab: 'updates' },
  },
} satisfies Record<string, HintDef>;

export type HintId = keyof typeof HINTS;

/** The hint text with its `{slot}`s filled. */
export function hintText(id: HintId, vars: Record<string, string> | null | undefined): string {
  return HINTS[id].text.replace(/\{(\w+)\}/g, (_, k: string) => vars?.[k] ?? '');
}

export const hintPlace = (id: HintId): 'header' | 'strip' | 'log' =>
  (HINTS[id] as HintDef).place ?? 'header';
