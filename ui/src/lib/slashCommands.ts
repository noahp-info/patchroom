/** Slash commands that open a TUI panel the chat layer cannot render. They fall back to the terminal. */
export const INTERACTIVE_SLASH = [
  'usage',
  'config',
  'model',
  'status',
  'agents',
  'mcp',
  'resume',
  'permissions',
  'hooks',
  'memory',
  'doctor',
  'context',
  'cost',
  'login',
  'logout',
  'ide',
  'theme',
  'vim',
  'export',
  'help',
  'plugin',
  'bashes',
  'todos',
  'output-style',
  'statusline',
] as const;

const SET = new Set<string>(INTERACTIVE_SLASH);

/** The command word of a message that is a slash command, lowercased; null for anything else. */
export function slashName(text: string): string | null {
  const m = /^\/([A-Za-z][\w:-]*)(?:\s|$)/.exec(text.trimStart());
  return m ? m[1].toLowerCase() : null;
}

/** A known command that opens a TUI panel. */
export function isInteractiveSlash(text: string): boolean {
  const n = slashName(text);
  return n !== null && SET.has(n);
}

/** Milliseconds an unknown slash command gets to produce a transcript item before the fallback. */
export const SLASH_QUIET_MS = 2000;
