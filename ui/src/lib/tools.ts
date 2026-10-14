import type { ToolItem, ToolState } from '../ipc';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const firstLine = (s: string): string =>
  s
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';

/** Display name: `mcp__server__tool` becomes `server: tool`. */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}: ${m[2]}` : name;
}

/** One-line gist of a tool call's input, for the collapsed line. */
export function toolSummary(name: string, input: unknown): string {
  if (typeof input === 'string') return firstLine(input);
  if (!isObj(input)) return '';
  const s = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined;
  switch (name) {
    case 'Bash':
      return firstLine(s('command') ?? '');
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return s('file_path') ?? s('notebook_path') ?? '';
    case 'Grep':
      return [s('pattern'), s('path')].filter(Boolean).join('  ');
    case 'Glob':
      return s('pattern') ?? '';
    case 'WebFetch':
      return s('url') ?? '';
    case 'WebSearch':
      return s('query') ?? '';
    case 'Agent':
    case 'Task':
      return s('description') ?? s('prompt')?.slice(0, 80) ?? '';
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : '';
    default: {
      for (const v of Object.values(input))
        if (typeof v === 'string' && v.trim()) return firstLine(v);
      return '';
    }
  }
}

export const TOOL_STATE_LABEL: Record<ToolState, string> = {
  pending: 'Waiting',
  running: 'Running',
  ok: 'Done',
  error: 'Failed',
  denied: 'Denied',
  interrupted: 'Interrupted',
};

/** Pretty JSON for the expanded input; strings print as they are. */
export function inputText(name: string, input: unknown): string {
  if (typeof input === 'string') return input;
  if (isObj(input) && name === 'Bash' && typeof input.command === 'string') {
    const rest = Object.entries(input).filter(([k]) => k !== 'command');
    return rest.length
      ? `${input.command}\n\n${JSON.stringify(Object.fromEntries(rest), null, 2)}`
      : input.command;
  }
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

export function toolItemSummary(item: ToolItem): string {
  return toolSummary(item.name, item.input);
}
