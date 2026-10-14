import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  down: <path d="m4 6 4 4 4-4" />,
  right: <path d="m6 4 4 4-4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  inbox: <path d="M2.5 9.5 4 3.5h8l1.5 6M2.5 9.5v3h11v-3M2.5 9.5h3.5l.5 1.5h3l.5-1.5h3.5" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  folder: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  section: <path d="M2.5 4h11M2.5 8h7M2.5 12h11M12 6.5v3M10.5 8h3" />,
  resume: <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3 2.5v3h3" />,
};

/** 16px stroke icon using the theme's `svg.i` rule. */
export function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg className="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** Claude provider mark. Colored by `--g-claude` through the theme's `.pg.claude`. */
export function ClaudeGlyph() {
  return (
    <svg className="pg claude" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 1.2 9.3 6.7 14.8 8 9.3 9.3 8 14.8 6.7 9.3 1.2 8 6.7 6.7z" />
    </svg>
  );
}
