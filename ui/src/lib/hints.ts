import type { PrefsTabId } from './prefsModule';

/**
 * First-time hints (DESIGN.md, First-time hints). Each feature that has a setting a person may
 * not find ships one entry here. A hint shows once, ever, at most one at a time, never blocks
 * and always offers the setting it mentions.
 */
export interface HintDef {
  /** Short and plain: what the person might want, and where it lives. */
  text: string;
  /** The button that opens the setting the hint names. */
  action: { label: string; tab: PrefsTabId };
}

export const HINTS = {
  'links.browser': {
    text: 'Want links to always open in your browser? Change it in Settings > Links.',
    action: { label: 'Open Links settings', tab: 'links' },
  },
} satisfies Record<string, HintDef>;

export type HintId = keyof typeof HINTS;
