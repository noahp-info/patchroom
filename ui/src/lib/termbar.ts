import type { CSSProperties } from 'react';
import { ensureContrast, mix, readableOn } from '../theme/color';

/**
 * Colors for the strip above a DM's terminal, read from that terminal's own background. The
 * strip then matches whatever palette the DM uses (light theme, iTerm black, a Slack import)
 * and its text stays at 4.5:1. An unreadable color falls back to the theme tokens in CSS.
 */
export function termbarStyle(bg: string | undefined): CSSProperties {
  if (!bg) return {};
  try {
    const ink = readableOn(bg);
    return {
      '--termbar-bg': bg,
      '--termbar-line': mix(bg, ink, 0.14),
      '--termbar-fg': ensureContrast(mix(bg, ink, 0.72), bg),
    } as CSSProperties;
  } catch {
    return {};
  }
}
