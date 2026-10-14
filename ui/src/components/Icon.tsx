import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  down: <path d="m4 6 4 4 4-4" />,
  right: <path d="m6 4 4 4-4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  inbox: <path d="M2.5 9.5 4 3.5h8l1.5 6M2.5 9.5v3h11v-3M2.5 9.5h3.5l.5 1.5h3l.5-1.5h3.5" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  folder: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  section: <path d="M2.5 4h11M2.5 8h7M2.5 12h11M12 6.5v3M10.5 8h3" />,
  chev: <path d="m6 4 4 4-4 4" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  term: <path d="M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10.5H11" />,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  send: <path d="M13.5 2.5 2.5 7l4.5 2 2 4.5zM7 9l6.5-6.5" />,
  slash: <path d="M10.5 2.5l-5 11" />,
  clip: (
    <path d="M11 6.5 7 10.5a1.4 1.4 0 0 1-2-2L9.5 4a2.6 2.6 0 0 1 3.7 3.7l-4.6 4.6a3.8 3.8 0 0 1-5.4-5.4L6 3.9" />
  ),
  branch: (
    <path d="M5 3v6.5M5 9.5a2 2 0 1 0 0 .01M11 3.5a1.5 1.5 0 1 0 0 .01M11 5v1a3 3 0 0 1-3 3H5" />
  ),
  down2: <path d="M8 3v9M4 8.5l4 4 4-4" />,
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
