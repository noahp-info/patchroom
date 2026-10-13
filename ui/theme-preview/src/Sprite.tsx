/** Icon and provider-glyph sprite. Mount once; elements reference symbols with <use href="#id">. */
export function Sprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <symbol id="p-claude" viewBox="0 0 16 16">
        <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M8 1.6v4.2M8 10.2v4.2M1.6 8h4.2M10.2 8h4.2M3.5 3.5l3 3M9.5 9.5l3 3M12.5 3.5l-3 3M6.5 9.5l-3 3" />
        </g>
      </symbol>
      <symbol id="p-cursor" viewBox="0 0 16 16">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M8 1.5 13.6 4.75v6.5L8 14.5 2.4 11.25v-6.5z" />
          <path d="M8 8 13.6 4.75M8 8v6.5M8 8 2.4 4.75" opacity=".55" />
        </g>
        <path d="M8 1.5 13.6 4.75 8 8z" fill="currentColor" />
      </symbol>
      <symbol id="p-codex" viewBox="0 0 16 16">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="3" />
          <path d="m5 6.4 2 1.6-2 1.6M8.6 10h2.6" />
        </g>
      </symbol>
      <symbol id="i-search" viewBox="0 0 16 16">
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" />
      </symbol>
      <symbol id="i-left" viewBox="0 0 16 16">
        <path d="M10 3 5 8l5 5" />
      </symbol>
      <symbol id="i-right" viewBox="0 0 16 16">
        <path d="m6 3 5 5-5 5" />
      </symbol>
      <symbol id="i-down" viewBox="0 0 16 16">
        <path d="m3.5 6 4.5 4.5L12.5 6" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 16 16">
        <path d="M8 3v10M3 8h10" />
      </symbol>
      <symbol id="i-hash" viewBox="0 0 16 16">
        <path d="M6 2.5 4.8 13.5M11.2 2.5 10 13.5M2.8 6h11M2.2 10h11" />
      </symbol>
      <symbol id="i-inbox" viewBox="0 0 16 16">
        <path d="M2 9.5 3.8 3.5h8.4L14 9.5v3H2z" />
        <path d="M2 9.5h3.5l1 1.5h3l1-1.5H14" />
      </symbol>
      <symbol id="i-thread" viewBox="0 0 16 16">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      </symbol>
      <symbol id="i-pencil" viewBox="0 0 16 16">
        <path d="m10.5 2.5 3 3-8 8H2.5v-3z" />
      </symbol>
      <symbol id="i-term" viewBox="0 0 16 16">
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" />
        <path d="m4.5 6.5 2 1.5-2 1.5M8 10h3" />
      </symbol>
      <symbol id="i-pin" viewBox="0 0 16 16">
        <path d="M9.8 2.2 13.8 6.2 11 7.4 8.6 9.8l.6 3-6-6 3-.6 2.4-2.4z" />
        <path d="m5.3 10.7-3 3" />
      </symbol>
      <symbol id="i-folder" viewBox="0 0 16 16">
        <path d="M2 4.2c0-.6.4-1 1-1h3l1.4 1.6H13c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
      </symbol>
      <symbol id="i-branch" viewBox="0 0 16 16">
        <circle cx="4.5" cy="3.5" r="1.5" />
        <circle cx="4.5" cy="12.5" r="1.5" />
        <circle cx="11.5" cy="5.5" r="1.5" />
        <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.3" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 16 16">
        <path d="m3 8.5 3 3 7-7" />
      </symbol>
      <symbol id="i-chev" viewBox="0 0 16 16">
        <path d="m6 4 4 4-4 4" />
      </symbol>
      <symbol id="i-edit" viewBox="0 0 16 16">
        <path d="M3 13h10M4 10.5 10.5 4l1.5 1.5L5.5 12H4z" />
      </symbol>
      <symbol id="i-clip" viewBox="0 0 16 16">
        <path d="M12.5 7.5 7.6 12.4a3 3 0 0 1-4.2-4.2l5.3-5.3a2 2 0 0 1 2.8 2.8L6.2 11a1 1 0 0 1-1.4-1.4l4.7-4.7" />
      </symbol>
      <symbol id="i-shot" viewBox="0 0 16 16">
        <path d="M4 1.5v10.5h10.5M1.5 4H12v10.5" />
      </symbol>
      <symbol id="i-slash" viewBox="0 0 16 16">
        <path d="m10.5 2.5-5 11" />
      </symbol>
      <symbol id="i-send" viewBox="0 0 16 16">
        <path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" />
      </symbol>
      <symbol id="i-link" viewBox="0 0 16 16">
        <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2.3-2.3a2.5 2.5 0 0 0-3.5-3.5L8.5 4M9 7a2.5 2.5 0 0 0-3.5 0L3.2 9.3a2.5 2.5 0 0 0 3.5 3.5L7.5 12" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 16 16">
        <path d="m4 4 8 8M12 4l-8 8" />
      </symbol>
      <symbol id="i-file" viewBox="0 0 16 16">
        <path d="M4 1.8h5l3 3v9.4H4z" />
        <path d="M9 1.8v3h3" />
      </symbol>
      <symbol id="i-globe" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
      </symbol>
      <symbol id="i-pr" viewBox="0 0 16 16">
        <circle cx="4.5" cy="3.5" r="1.5" />
        <circle cx="4.5" cy="12.5" r="1.5" />
        <circle cx="11.5" cy="12.5" r="1.5" />
        <path d="M4.5 5v6M11.5 11V6.5c0-1-.5-1.5-1.5-1.5H7.5M9 3.5 7.5 5 9 6.5" />
      </symbol>
      <symbol id="i-more" viewBox="0 0 16 16">
        <circle cx="3.5" cy="8" r=".6" />
        <circle cx="8" cy="8" r=".6" />
        <circle cx="12.5" cy="8" r=".6" />
      </symbol>
    </svg>
  );
}
