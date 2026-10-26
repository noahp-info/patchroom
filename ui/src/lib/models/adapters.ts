import type { StatusChips, ToolId } from '../../ipc';

/**
 * How Patchroom drives one CLI's model, without knowing the CLI anywhere else. Every tool
 * answers three questions: the launch flag, the switch command typed into its terminal, and
 * how to read the model it reports.
 */
export interface ToolAdapter {
  id: ToolId;
  name: string;
  /** Arguments that launch the CLI on `model`. Null when the tool has no launch flag. */
  launchArgs(model: string): string[] | null;
  /** Text typed into an idle session to switch it to `model`. Null when it cannot switch. */
  switchCommand(model: string): string | null;
  /** The model the CLI reports right now, from its status facts. */
  currentModel(chips: StatusChips | undefined): { id?: string; name?: string };
  /** Patchroom drives this tool today. A stub declares the shape only. */
  ready: boolean;
}

/** A model string is safe for a command line and a terminal: no spaces, quotes or control keys. */
export const SAFE_MODEL = /^[A-Za-z0-9._:/@[\]-]{1,128}$/;
export const safeModel = (m: string): boolean => SAFE_MODEL.test(m) && !m.startsWith('-');

const claudeCode: ToolAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  launchArgs: (model) => (safeModel(model) ? ['--model', model] : null),
  switchCommand: (model) => (safeModel(model) ? `/model ${model}` : null),
  currentModel: (chips) => ({ id: chips?.modelId, name: chips?.model }),
  ready: true,
};

/** Declared for P6: the shape is fixed now, the CLI wiring lands with each adapter. */
function stub(id: ToolId, name: string): ToolAdapter {
  return {
    id,
    name,
    launchArgs: () => null,
    switchCommand: () => null,
    currentModel: (chips) => ({ id: chips?.modelId, name: chips?.model }),
    ready: false,
  };
}

export const ADAPTERS: Record<ToolId, ToolAdapter> = {
  'claude-code': claudeCode,
  codex: stub('codex', 'Codex'),
  cursor: stub('cursor', 'Cursor CLI'),
  gemini: stub('gemini', 'Gemini CLI'),
  opencode: stub('opencode', 'opencode'),
};

export const TOOL_IDS = Object.keys(ADAPTERS) as ToolId[];

export const adapterOf = (tool: string): ToolAdapter | undefined =>
  (ADAPTERS as Record<string, ToolAdapter | undefined>)[tool];

/** The base of a model id: no `[1m]` style suffix, no date. */
const baseId = (id: string) =>
  id
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');

/**
 * Did the CLI take the model we asked for? The reported id wins: equal, or the same base
 * (`claude-opus-4-8[1m]` reports `claude-opus-4-8`). Aliases (`sonnet`) match the reported name.
 */
export function modelTook(requested: string, chips: StatusChips | undefined): boolean {
  const id = chips?.modelId;
  const want = baseId(requested);
  if (id && (id === requested || baseId(id) === want)) return true;
  const name = chips?.model?.toLowerCase();
  if (!name) return false;
  // An alias like `sonnet` or `opus`: the display name carries the family.
  return /^[a-z]+$/.test(want) && name.includes(want);
}
