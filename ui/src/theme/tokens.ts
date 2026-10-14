/**
 * The color token contract. A color theme is exactly these keys, once for light and once for dark.
 * Every token becomes a CSS custom property named `--<key>` on the app root.
 * Keep this file, theme.schema.json and DESIGN.md in step (a test enforces the first two).
 */

export const TOKEN_GROUPS = {
  surface: ['bg', 'fg', 'muted', 'line', 'hover', 'surface', 'frame', 'sel'],
  titlebar: ['tb-bg', 'tb-fg', 'tb-muted', 'tb-field', 'tb-line'],
  sidebar: [
    'side-bg',
    'side-fg',
    'side-muted',
    'side-strong',
    'side-line',
    'side-hover',
    'side-active',
    'side-active-fg',
    'ws-mark',
    'ws-mark-fg',
  ],
  accent: ['accent', 'accent-hover', 'accent-fg', 'accent-text', 'link'],
  status: ['needs', 'needs-fg', 'busy', 'idle', 'err', 'err-text', 'ok', 'unread', 'unread-fg'],
  provider: ['g-claude', 'g-cursor', 'g-codex'],
  chrome: [
    'chip',
    'chip-fg',
    'mode-bg',
    'mode-fg',
    'ctx',
    'av-user',
    'av-user-fg',
    'av-bot',
    'code-bg',
    'mark',
    'mark-line',
    'ask-line',
    'ask-head',
    'ask-head-fg',
    'opt-sel',
    'opt-sel-line',
    'box-line',
    'box-bg',
    'q-bg',
    'stop-line',
    'stop',
  ],
  artifact: [
    'art-bg',
    'art-sheet',
    'hunk',
    'add-bg',
    'add-gut',
    'del-bg',
    'del-gut',
    'syn-kw',
    'syn-cm',
    'syn-ty',
    'syn-fn',
  ],
  hardware: [
    'panel',
    'panel-2',
    'panel-edge',
    'silk',
    'silk-muted',
    'nut',
    'hole',
    'c-red',
    'c-yellow',
    'c-blue',
    'c-green',
    'cable',
    'plug',
  ],
} as const;

export type TokenGroup = keyof typeof TOKEN_GROUPS;
export type TokenKey = (typeof TOKEN_GROUPS)[TokenGroup][number];

export const TOKEN_KEYS: readonly TokenKey[] = Object.values(TOKEN_GROUPS).flat();

export const TOKEN_GROUP_NOTES: Record<TokenGroup, string> = {
  surface: 'Main pane ground, ink, hairlines, hover wash, raised surface, window frame, selection.',
  titlebar: 'Window title bar and its search field.',
  sidebar: 'Sidebar ground and text roles, active row, workspace mark.',
  accent: 'Primary action color, its text-safe twin, and link color.',
  status:
    'Presence and attention: needs you, busy, idle, errored (err is the signal color for dots, LEDs and borders; err-text is its text-safe twin on light and dark surfaces), success, unread badge.',
  provider: 'Provider glyph colors (Claude, Cursor, Codex).',
  chrome: 'Chips, status strip, avatars, inline code, highlights, ask widget, composer, Stop.',
  artifact: 'Artifact pane ground, diff gutters and fills, syntax colors.',
  hardware:
    'Panel, silkscreen, nut, hole, four chip colors, and the patch cable and plug metal. Read by Patch Bay only, but every theme must define them so any theme fits any base. A theme saved before `cable` and `plug` existed gets both filled on load.',
};

/** A text-bearing pair that must reach WCAG AA (4.5:1 for normal text, 3:1 for large or bold UI). */
export interface ContrastPair {
  fg: TokenKey;
  bg: TokenKey;
  min: number;
  what: string;
  /** Token that sits under a translucent `bg`. Defaults to `bg`. */
  ground?: TokenKey;
}

const T = 4.5;
/** Graphic objects need 3:1 (WCAG 1.4.11). */
const G = 3;
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: 'fg', bg: 'bg', min: T, what: 'message text' },
  { fg: 'fg', bg: 'surface', min: T, what: 'text on raised surface' },
  { fg: 'muted', bg: 'bg', min: T, what: 'secondary text' },
  { fg: 'muted', bg: 'surface', min: T, what: 'secondary text on raised surface' },
  { fg: 'muted', bg: 'art-sheet', min: T, what: 'secondary text on artifact sheet' },
  { fg: 'muted', bg: 'code-bg', min: T, what: 'secondary text on code' },
  { fg: 'fg', bg: 'code-bg', min: T, what: 'inline code' },
  { fg: 'fg', bg: 'mark', min: T, what: 'highlighted text' },
  { fg: 'fg', bg: 'opt-sel', min: T, what: 'selected option' },
  { fg: 'muted', bg: 'opt-sel', min: T, what: 'selected option detail' },
  { fg: 'fg', bg: 'q-bg', min: T, what: 'queued comment' },
  { fg: 'muted', bg: 'q-bg', min: T, what: 'queued quote' },
  { fg: 'fg', bg: 'box-bg', min: T, what: 'composer text' },
  { fg: 'muted', bg: 'box-bg', min: T, what: 'composer placeholder' },
  { fg: 'accent-text', bg: 'bg', min: T, what: 'accent text' },
  { fg: 'accent-text', bg: 'opt-sel', min: T, what: 'Recommended tag' },
  { fg: 'link', bg: 'bg', min: T, what: 'link' },
  { fg: 'accent-fg', bg: 'accent', min: T, what: 'primary button' },
  { fg: 'accent-fg', bg: 'accent-hover', min: T, what: 'primary button hover' },
  { fg: 'needs-fg', bg: 'needs', min: T, what: 'needs-you badge' },
  { fg: 'unread-fg', bg: 'unread', min: T, what: 'unread badge' },
  { fg: 'side-strong', bg: 'side-bg', min: T, what: 'error badge mark on sidebar' },
  { fg: 'ok', bg: 'surface', min: T, what: 'tool success' },
  { fg: 'err-text', bg: 'surface', min: T, what: 'tool deletions' },
  { fg: 'ok', bg: 'art-sheet', min: T, what: 'added line count' },
  { fg: 'err-text', bg: 'art-sheet', min: T, what: 'removed line count' },
  { fg: 'stop', bg: 'bg', min: T, what: 'Stop button' },
  { fg: 'chip-fg', bg: 'chip', min: T, what: 'status chip' },
  { fg: 'muted', bg: 'chip', min: T, what: 'dim text on chip' },
  { fg: 'mode-fg', bg: 'mode-bg', min: T, what: 'mode chip' },
  { fg: 'ask-head-fg', bg: 'ask-head', min: T, what: 'ask widget header' },
  { fg: 'av-user-fg', bg: 'av-user', min: T, what: 'user avatar initials' },
  { fg: 'g-claude', bg: 'av-bot', min: 3, what: 'Claude glyph on avatar (graphic)' },
  { fg: 'tb-fg', bg: 'tb-bg', min: T, what: 'title bar text' },
  { fg: 'tb-muted', bg: 'tb-field', min: T, what: 'title bar search placeholder' },
  { fg: 'tb-muted', bg: 'tb-bg', min: T, what: 'title bar secondary text' },
  { fg: 'side-fg', bg: 'side-bg', min: T, what: 'sidebar rows' },
  { fg: 'side-fg', bg: 'side-hover', min: T, what: 'sidebar row hover', ground: 'side-bg' },
  { fg: 'side-muted', bg: 'side-bg', min: T, what: 'sidebar section labels' },
  {
    fg: 'side-muted',
    bg: 'side-hover',
    min: T,
    what: 'sidebar muted text on a hovered row',
    ground: 'side-bg',
  },
  { fg: 'side-strong', bg: 'side-bg', min: 7, what: 'sidebar section headers' },
  { fg: 'side-strong', bg: 'side-bg', min: T, what: 'unread row names' },
  { fg: 'side-active-fg', bg: 'side-active', min: T, what: 'active sidebar row' },
  { fg: 'ws-mark-fg', bg: 'ws-mark', min: T, what: 'workspace mark' },
  { fg: 'muted', bg: 'art-bg', min: T, what: 'artifact tabs' },
  { fg: 'fg', bg: 'art-sheet', min: T, what: 'artifact text' },
  { fg: 'fg', bg: 'add-bg', min: T, what: 'added diff line' },
  { fg: 'fg', bg: 'del-bg', min: T, what: 'removed diff line' },
  { fg: 'muted', bg: 'add-gut', min: T, what: 'added line number' },
  { fg: 'muted', bg: 'del-gut', min: T, what: 'removed line number' },
  { fg: 'muted', bg: 'hunk', min: T, what: 'hunk header' },
  { fg: 'syn-kw', bg: 'art-sheet', min: T, what: 'syntax keyword' },
  { fg: 'syn-cm', bg: 'art-sheet', min: T, what: 'syntax comment' },
  { fg: 'syn-ty', bg: 'art-sheet', min: T, what: 'syntax type' },
  { fg: 'syn-fn', bg: 'art-sheet', min: T, what: 'syntax function' },
  { fg: 'syn-kw', bg: 'add-bg', min: T, what: 'syntax keyword on added line' },
  { fg: 'syn-cm', bg: 'add-bg', min: T, what: 'syntax comment on added line' },
  { fg: 'syn-ty', bg: 'add-bg', min: T, what: 'syntax type on added line' },
  { fg: 'syn-kw', bg: 'del-bg', min: T, what: 'syntax keyword on removed line' },
  { fg: 'syn-ty', bg: 'del-bg', min: T, what: 'syntax type on removed line' },
  { fg: 'syn-fn', bg: 'del-bg', min: T, what: 'syntax function on removed line' },
  { fg: 'silk', bg: 'panel', min: T, what: 'panel silkscreen' },
  { fg: 'silk-muted', bg: 'panel', min: T, what: 'panel secondary silkscreen' },
  { fg: 'silk', bg: 'panel-2', min: T, what: 'recessed panel text' },
  { fg: 'silk-muted', bg: 'panel-2', min: T, what: 'recessed panel secondary text' },
  { fg: 'side-fg', bg: 'panel', min: T, what: 'Patch Bay sidebar rows' },
  { fg: 'side-muted', bg: 'panel', min: T, what: 'Patch Bay sidebar labels' },
  { fg: 'side-strong', bg: 'panel', min: T, what: 'Patch Bay unread names' },
  { fg: 'side-strong', bg: 'panel', min: 7, what: 'Patch Bay section headers' },
  { fg: 'side-active-fg', bg: 'side-active', min: T, what: 'Patch Bay active row' },
  { fg: 'tb-fg', bg: 'panel-2', min: T, what: 'Patch Bay title bar' },
  { fg: 'tb-muted', bg: 'panel-2', min: T, what: 'Patch Bay title bar secondary text' },
  { fg: 'cable', bg: 'hole', min: G, what: 'patch cable in a jack (graphic)' },
  { fg: 'plug', bg: 'hole', min: G, what: 'plug metal in a jack (graphic)' },
];
