import type { BaseId, BaseInfo } from './types.ts';

/** Registry of layout bases. The CSS for each lives in `bases/<id>.css`. */
export const BASES: readonly BaseInfo[] = [
  {
    id: 'homeroom',
    name: 'Homeroom',
    tagline: 'Slack-faithful. The default.',
    status: 'ready',
    baseOnly: [],
  },
  {
    id: 'patchbay',
    name: 'Patch Bay',
    tagline: 'Hardware panel: silkscreen labels, jacks, one patch cable.',
    status: 'ready',
    baseOnly: ['jack', 'screw', 'patch cable', 'silkscreen labels', 'jack-style radios'],
  },
  {
    id: 'scrollback',
    name: 'Scrollback',
    tagline: 'Terminal-native. Stub: dimensions, type and radii only.',
    status: 'stub',
    baseOnly: [],
  },
  {
    id: 'bluepencil',
    name: 'Blue Pencil',
    tagline: 'Editorial calm. Stub: dimensions, type and radii only.',
    status: 'stub',
    baseOnly: [],
  },
];

export const DEFAULT_BASE: BaseId = 'homeroom';

export function getBase(id: string): BaseInfo | undefined {
  return BASES.find((b) => b.id === id);
}
