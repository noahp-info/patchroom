import { contrast, ensureContrast, mix } from './color.ts';
import { contrastReport } from './validate.ts';
import type { Theme } from './types.ts';

/** Ink for text that sits on a fill: white, or a dark tinted from the fill, whichever clears 4.5:1. */
function inkOn(fill: string): string {
  return contrast('#ffffff', fill) >= 4.55 ? '#ffffff' : mix(fill, '#000000', 0.88);
}

/**
 * Nudge failing foreground tokens until every text pair meets its minimum. Only foregrounds move;
 * grounds never do, so a theme's surfaces stay exactly as authored. `-fg` tokens (ink on a fill)
 * flip to white or a tinted dark instead of fading to grey. Gives up after four passes.
 */
export function repairContrast(theme: Theme): Theme {
  const out: Theme = {
    ...theme,
    modes: { light: { ...theme.modes.light }, dark: { ...theme.modes.dark } },
  };
  for (let pass = 0; pass < 4; pass++) {
    const fails = contrastReport(out);
    if (fails.length === 0) break;
    for (const f of fails) {
      const m = out.modes[f.mode];
      const { fg, bg } = f.pair;
      m[fg] = fg.endsWith('-fg') ? inkOn(m[bg]) : ensureContrast(m[fg], m[bg], f.pair.min + 0.03);
    }
  }
  return out;
}
