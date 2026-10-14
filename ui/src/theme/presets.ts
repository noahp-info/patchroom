import type { ThemeMode } from './types.ts';

/** `cablePreset` value that leaves the theme's own `cable` and `plug` alone. */
export const THEME_CABLE = 'theme';

export interface CablePreset {
  id: string;
  name: string;
  blurb: string;
  /** Rubber cable and metal plug, once per mode. A preset sets these two tokens and nothing else. */
  modes: Record<ThemeMode, { cable: string; plug: string }>;
}

const same = (cable: string, plug: string) => ({
  light: { cable, plug },
  dark: { cable, plug },
});

/**
 * Patch Bay cable and plug pairs. Jade is the brand pair and matches Homeroom's own tokens.
 * Studio's rubber is graphite, not black: black vanishes inside the dark socket ring that
 * carries the 3:1 graphic contrast.
 */
export const CABLE_PRESETS: readonly CablePreset[] = [
  {
    id: 'jade',
    name: 'Jade',
    blurb: 'Marigold rubber, silver plugs.',
    modes: same('#f2c35b', '#c7cdd0'),
  },
  {
    id: 'signal',
    name: 'Signal',
    blurb: 'Red rubber, silver plugs.',
    modes: same('#e0483c', '#c7cdd0'),
  },
  {
    id: 'studio',
    name: 'Studio',
    blurb: 'Graphite rubber, brass plugs.',
    modes: same('#80848a', '#c9a24a'),
  },
  {
    id: 'ocean',
    name: 'Ocean',
    blurb: 'Blue rubber, silver plugs.',
    modes: same('#4a9be0', '#c7cdd0'),
  },
  {
    id: 'copper',
    name: 'Copper',
    blurb: 'Burnt orange rubber, brass plugs.',
    modes: same('#d9692a', '#c9a24a'),
  },
];

export function getCablePreset(id: string | undefined): CablePreset | undefined {
  return CABLE_PRESETS.find((p) => p.id === id);
}

/** The two tokens a preset overrides in `mode`, or an empty object for "follow the theme". */
export function presetVars(id: string | undefined, mode: ThemeMode): Record<string, string> {
  const p = getCablePreset(id);
  return p ? { '--cable': p.modes[mode].cable, '--plug': p.modes[mode].plug } : {};
}
