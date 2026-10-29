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
  mic: (
    <path d="M8 2a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0V4a2 2 0 0 0-2-2zM4 7.5a4 4 0 0 0 8 0M8 11.5V14M5.5 14h5" />
  ),
  clip: (
    <path d="M11 6.5 7 10.5a1.4 1.4 0 0 1-2-2L9.5 4a2.6 2.6 0 0 1 3.7 3.7l-4.6 4.6a3.8 3.8 0 0 1-5.4-5.4L6 3.9" />
  ),
  branch: (
    <path d="M5 3v6.5M5 9.5a2 2 0 1 0 0 .01M11 3.5a1.5 1.5 0 1 0 0 .01M11 5v1a3 3 0 0 1-3 3H5" />
  ),
  worktree: <path d="M4 2.5v11M4 8h5.5A2.5 2.5 0 0 0 12 5.5v-2M10 3.5h4M2.5 2.5h3M2.5 13.5h3" />,
  down2: <path d="M8 3v9M4 8.5l4 4 4-4" />,
  pencil: <path d="M10.5 3 13 5.5 6 12.5l-3.2.7.7-3.2zM9 4.5 11.5 7" />,
  star: <path d="m8 2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2 4.4 13.1l.7-4L2.2 6.3l4-.6z" />,
  archive: <path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3" />,
  pin: <path d="M9.5 2.5 13.5 6.5l-1.5.5-2 2 .2 3-1-.5-2.2-2.2L3 13l3.2-4L4 6.8l-.5-1 3-.2 2-2z" />,
  bookmark: <path d="M4 2.5h8v11l-4-3-4 3z" />,
  copy: <path d="M5.5 5.5h7v8h-7zM3.5 10.5v-8h7" />,
  smile: (
    <path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM5.8 9.5a2.6 2.6 0 0 0 4.4 0M6 6.5v.5M10 6.5v.5" />
  ),
  search: <path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5l3 3" />,
  bell: <path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3" />,
  gear: (
    <path d="M6.34 3.18L6.49 1.47L9.51 1.47L9.66 3.18L10.24 3.42L11.55 2.32L13.68 4.45L12.58 5.76L12.82 6.34L14.53 6.49L14.53 9.51L12.82 9.66L12.58 10.24L13.68 11.55L11.55 13.68L10.24 12.58L9.66 12.82L9.51 14.53L6.49 14.53L6.34 12.82L5.76 12.58L4.45 13.68L2.32 11.55L3.42 10.24L3.18 9.66L1.47 9.51L1.47 6.49L3.18 6.34L3.42 5.76L2.32 4.45L4.45 2.32L5.76 3.42ZM8 5.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2z" />
  ),
  grip: (
    <path d="M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01" strokeWidth="2.2" />
  ),
  lock: <path d="M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2" />,
  resume: <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3 2.5v3h3" />,
  ext: <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />,
  shot: <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M6 8h4M8 6v4" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.4" />,
  comment: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2zM5 6h6M5 8h4" />,
  user: (
    <path d="M8 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3 13.5c.5-2.5 2.5-4 5-4s4.5 1.5 5 4" />
  ),
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
