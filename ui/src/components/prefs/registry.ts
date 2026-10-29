/**
 * Every setting Settings can search. One entry per setting row: add an entry and give the row
 * `data-setting="<id>"`, and search finds it, opens its section, scrolls to it and flashes it.
 * `ui/tests/prefs-search.spec.ts` fails when a rendered row has no entry, or an entry no row.
 * Pure data: no React, so tests import it directly.
 */

export const SECTIONS = [
  { id: 'themes', label: 'Themes' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'statusbar', label: 'Status bar' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'sounds', label: 'Sounds' },
  { id: 'dnd', label: 'Do Not Disturb' },
  { id: 'hooks', label: 'Sound hooks' },
  { id: 'links', label: 'Links' },
  { id: 'history', label: 'History' },
  { id: 'models', label: 'Models' },
  { id: 'updates', label: 'Updates' },
  { id: 'accounts', label: 'Accounts' },
] as const;
export type SectionId = (typeof SECTIONS)[number]['id'];

export interface SettingEntry {
  id: string;
  section: SectionId;
  label: string;
  description: string;
  keywords?: readonly string[];
  /** Rendered only in some states (a session exists, a check is on). Search still lists it. */
  conditional?: boolean;
}

export const SETTINGS: readonly SettingEntry[] = [
  // Themes
  {
    id: 'themes.appearance',
    section: 'themes',
    label: 'Appearance',
    description: 'Light, dark, or follow macOS.',
    keywords: ['light', 'dark', 'mode', 'system', 'night'],
  },
  {
    id: 'themes.style',
    section: 'themes',
    label: 'Style',
    description: 'The layout: Homeroom or Patch Bay.',
    keywords: ['base', 'layout', 'homeroom', 'patch bay'],
  },
  {
    id: 'themes.emoji',
    section: 'themes',
    label: 'Emoji in chat',
    description: 'Apple or Noto Color emoji in messages and the terminal.',
    keywords: ['apple', 'noto', 'emoji'],
  },
  {
    id: 'themes.autoscroll',
    section: 'themes',
    label: 'Auto-scroll to new messages',
    description: 'Chat logs follow new messages until you scroll up.',
    keywords: ['chat', 'scroll', 'follow', 'paused'],
  },
  {
    id: 'themes.carrydraft',
    section: 'themes',
    label: 'Carry chat draft to the terminal',
    description: 'Switching to the terminal types your unsent chat text into Claude, unsent.',
    keywords: ['draft', 'composer', 'terminal', 'view', 'switch', 'move', 'unsent'],
  },
  {
    id: 'themes.fonts',
    section: 'themes',
    label: 'Fonts',
    description: 'Family and size for the UI, chat, code, sidebar and status bar.',
    keywords: ['font', 'typeface', 'type', 'text size', 'family', 'reset all'],
  },
  {
    id: 'themes.fonts.ui',
    section: 'themes',
    label: 'UI font',
    description: 'The default font and size for everything.',
    keywords: ['font', 'size', 'text', 'interface'],
  },
  {
    id: 'themes.fonts.chat',
    section: 'themes',
    label: 'Chat messages font',
    description: 'Font and size of messages and threads.',
    keywords: ['font', 'size', 'messages', 'reading'],
  },
  {
    id: 'themes.fonts.code',
    section: 'themes',
    label: 'Code and terminal font',
    description: 'Fixed-pitch font and size for code blocks, diffs and the terminal.',
    keywords: ['font', 'mono', 'monospace', 'fixed pitch', 'terminal font', 'size'],
  },
  {
    id: 'themes.fonts.sidebar',
    section: 'themes',
    label: 'Sidebar font',
    description: 'Font and size of sections and sessions.',
    keywords: ['font', 'size'],
  },
  {
    id: 'themes.fonts.statusBar',
    section: 'themes',
    label: 'Status bar font',
    description: 'Font and size of the strip under the composer.',
    keywords: ['font', 'size', 'strip'],
  },
  {
    id: 'themes.theme',
    section: 'themes',
    label: 'Theme',
    description: 'The color theme: Homeroom, Patch Bay, Ansi Slate, Cool Paper or your own.',
    keywords: ['color', 'colour', 'palette', 'colors'],
  },
  {
    id: 'themes.cable',
    section: 'themes',
    label: 'Patch Bay cable',
    description: 'The cable and plug colors of the Patch Bay look.',
    keywords: ['cable', 'plug', 'preset'],
  },
  {
    id: 'themes.custom',
    section: 'themes',
    label: 'New custom theme',
    description: 'Edit every color token of a theme of your own.',
    keywords: ['editor', 'colors', 'custom'],
  },
  {
    id: 'themes.slack',
    section: 'themes',
    label: 'Import a Slack theme',
    description: "Paste Slack's custom theme string.",
    keywords: ['slack', 'theme string', 'import'],
  },
  {
    id: 'themes.import',
    section: 'themes',
    label: 'Import a theme from another app',
    description: 'An app theme from iTerm2, Ghostty, Warp, VS Code, Cursor or Terminal.',
    keywords: ['iterm', 'ghostty', 'warp', 'vs code', 'cursor', 'terminal.app', 'import'],
  },

  // Terminal
  {
    id: 'terminal.default',
    section: 'terminal',
    label: 'Terminal style for all sessions',
    description: 'Palette, font and size of every terminal.',
    keywords: ['palette', 'colors', 'font', 'size', 'solarized', 'iterm'],
  },
  {
    id: 'terminal.session',
    section: 'terminal',
    label: 'Terminal style for one session',
    description: 'A palette, font or size of its own for one session.',
    keywords: ['palette', 'font', 'per session'],
    conditional: true,
  },
  {
    id: 'terminal.import',
    section: 'terminal',
    label: 'Import a terminal look from another app',
    description: 'Palette, font and size from iTerm2, Ghostty, Warp, VS Code, Cursor or Terminal.',
    keywords: ['iterm', 'ghostty', 'warp', 'vs code', 'cursor', 'terminal.app', 'import'],
  },

  // Status bar
  {
    id: 'statusbar.scope',
    section: 'statusbar',
    label: 'Status bar layout',
    description: 'Which modules show, in what order, for all sessions or one.',
    keywords: ['modules', 'chips', 'reorder', 'layout', 'strip'],
  },
  {
    id: 'statusbar.labels',
    section: 'statusbar',
    label: 'Status bar labels',
    description: 'Text and an emoji in front of a module value.',
    keywords: ['label', 'emoji', 'module'],
  },
  {
    id: 'statusbar.options',
    section: 'statusbar',
    label: 'Status bar module options',
    description:
      'Folder name or path, context meter, cost rounding. Open with the gear on a module.',
    keywords: ['options', 'configure', 'folder', 'path', 'context', 'meter', 'cost', 'decimals'],
    conditional: true,
  },
  {
    id: 'statusbar.suggest',
    section: 'statusbar',
    label: 'Suggest a module',
    description: 'Opens a GitHub issue form to propose a module or submit a script for review.',
    keywords: ['suggest', 'new module', 'script', 'submit', 'request', 'github', 'issue'],
  },

  // Notifications
  {
    id: 'notifications.default',
    section: 'notifications',
    label: 'Notify me about',
    description: 'Every event, only needs-you, or nothing.',
    keywords: ['alerts', 'banner', 'needs you', 'mute'],
  },
  {
    id: 'notifications.session',
    section: 'notifications',
    label: 'Notifications per session',
    description: 'A notification level of its own for one session.',
    keywords: ['mute', 'per session'],
  },
  {
    id: 'notifications.test',
    section: 'notifications',
    label: 'Send test notification',
    description: 'Check that macOS shows Patchroom notifications.',
    keywords: ['test', 'try'],
  },

  // Sounds
  {
    id: 'sounds.master',
    section: 'sounds',
    label: 'Play sounds',
    description: 'Turn every sound on or off, and set the volume.',
    keywords: ['volume', 'mute', 'audio', 'loud'],
  },
  {
    id: 'sounds.mix',
    section: 'sounds',
    label: 'Mix by event',
    description: 'A sound for each event from any pack, your own file, or Off.',
    keywords: ['event', 'custom sound', 'wav', 'mp3', 'file'],
  },
  {
    id: 'sounds.packs',
    section: 'sounds',
    label: 'Sound packs',
    description: 'Sets of sounds, one for each event.',
    keywords: ['pack', 'patch tones'],
  },
  {
    id: 'sounds.claude',
    section: 'sounds',
    label: 'Your Claude sounds',
    description: 'Bring in the sounds your Claude hooks play.',
    keywords: ['claude', 'hooks', 'import'],
  },
  {
    id: 'sounds.session',
    section: 'sounds',
    label: 'Sounds for one session',
    description: 'Mute a session, or give it a pack of its own.',
    keywords: ['per session', 'mute'],
  },
  {
    id: 'sounds.credits',
    section: 'sounds',
    label: 'Sound credits',
    description: 'Where the sounds come from and their licenses.',
    keywords: ['license', 'attribution'],
  },

  // Do Not Disturb
  {
    id: 'dnd.manual',
    section: 'dnd',
    label: 'Pause notifications and sounds now',
    description: 'Do Not Disturb until you turn it off.',
    keywords: ['dnd', 'quiet', 'silence', 'focus'],
  },
  {
    id: 'dnd.schedule',
    section: 'dnd',
    label: 'Do Not Disturb schedule',
    description: 'Days and hours when Patchroom stays quiet.',
    keywords: ['dnd', 'quiet hours', 'night', 'schedule'],
  },

  // Sound hooks
  {
    id: 'hooks.policy',
    section: 'hooks',
    label: 'Existing sound hooks',
    description: 'Keep your own hook sound or play both.',
    keywords: ['hooks', 'afplay', 'double sound', 'keep yours'],
  },

  // Links
  {
    id: 'links.open',
    section: 'links',
    label: 'Open links in',
    description: 'Patchroom or your browser. Hold Command for the other.',
    keywords: ['browser', 'safari', 'chrome', 'viewer', 'side pane', 'url'],
  },
  {
    id: 'links.artifacts',
    section: 'links',
    label: 'Artifacts',
    description: 'How artifacts Claude publishes are kept.',
    keywords: ['artifact'],
  },
  {
    id: 'links.autopin',
    section: 'links',
    label: 'Pin artifacts automatically',
    description: 'Each artifact is pinned once in its session.',
    keywords: ['pin', 'artifact'],
  },

  // History
  {
    id: 'history.group',
    section: 'history',
    label: 'Group History by',
    description: 'Folder, date, model or branch. The History header changes it too.',
    keywords: ['history', 'sessions', 'group', 'folder', 'date', 'model', 'branch', 'resume'],
  },

  // Models
  {
    id: 'models.ask',
    section: 'models',
    label: 'Check for newer models question',
    description: 'Turn on the newer-model check from here.',
    keywords: ['newer', 'catalog'],
    conditional: true,
  },
  {
    id: 'models.bundles',
    section: 'models',
    label: 'Model bundles',
    description: 'Named sets of models you switch between from the model chip.',
    keywords: ['bundle', 'opus', 'sonnet', 'model', 'switch'],
  },
  {
    id: 'models.scope',
    section: 'models',
    label: 'Where bundles apply',
    description: 'A bundle per folder, section or session.',
    keywords: ['per folder', 'per section', 'default bundle'],
    conditional: true,
  },
  {
    id: 'models.labels',
    section: 'models',
    label: 'Model labels',
    description: 'How the model chip names models, cloud or local.',
    keywords: ['label', 'cloud', 'local', 'name'],
  },
  {
    id: 'models.labels.cloud',
    section: 'models',
    label: 'Cloud model label',
    description: 'Icon and name, name only, or your own template.',
    keywords: ['label', 'cloud', 'icon', 'emoji', 'name only', 'template', 'chip'],
  },
  {
    id: 'models.labels.local',
    section: 'models',
    label: 'Local model label',
    description: 'Icon and name, name only, or your own template.',
    keywords: ['label', 'local', 'laptop', 'icon', 'emoji', 'name only', 'template', 'chip'],
  },

  // Updates
  {
    id: 'updates.app',
    section: 'updates',
    label: 'Check for app updates',
    description: 'Look up the newest Patchroom release at start. Off by default.',
    keywords: ['update', 'release', 'version', 'upgrade'],
  },
  {
    id: 'updates.models',
    section: 'updates',
    label: 'Check for newer models',
    description: 'Fetch the signed model list between builds. Off by default.',
    keywords: ['update', 'catalog', 'model list'],
  },

  // Accounts
  {
    id: 'accounts.claude',
    section: 'accounts',
    label: 'claude.ai sign-in',
    description: 'Sign in once so claude.ai artifacts open in the side pane.',
    keywords: ['sign in', 'sign out', 'login', 'log in', 'account', 'cookies'],
  },
];

export const settingById = (id: string): SettingEntry | undefined =>
  SETTINGS.find((s) => s.id === id);

export const sectionLabel = (id: SectionId): string =>
  SECTIONS.find((s) => s.id === id)?.label ?? id;

/** One search result: a whole section, or one setting in it. */
export interface SearchResult {
  section: SectionId;
  /** Absent: the section itself. */
  setting?: SettingEntry;
}

/**
 * Settings that match every word of `query` in their section name, label, description or
 * keywords, case-insensitive. A section whose name matches comes first, then its settings,
 * then the rest by how well the label matches.
 */
export function searchSettings(query: string): SearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const has = (text: string) => words.every((w) => text.includes(w));
  const out: { r: SearchResult; score: number; order: number }[] = [];
  SECTIONS.forEach((sec, si) => {
    if (has(sec.label.toLowerCase()))
      out.push({ r: { section: sec.id }, score: 0, order: si * 1000 });
  });
  SETTINGS.forEach((s, i) => {
    const label = s.label.toLowerCase();
    const sec = sectionLabel(s.section).toLowerCase();
    const kw = (s.keywords ?? []).join(' ').toLowerCase();
    const hay = `${sec} ${label} ${s.description.toLowerCase()} ${kw}`;
    if (!has(hay)) return;
    const score = words.every((w) => label.startsWith(w))
      ? 1
      : has(label)
        ? 2
        : has(`${label} ${kw}`)
          ? 3
          : has(sec)
            ? 4
            : 5;
    out.push({ r: { section: s.section, setting: s }, score, order: i });
  });
  return out.sort((a, b) => a.score - b.score || a.order - b.order).map((x) => x.r);
}
