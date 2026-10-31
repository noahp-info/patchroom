/**
 * Keyboard bytes that xterm.js does not produce on its own.
 *
 * claude asks for the kitty keyboard protocol (`CSI > 5 u`) and modifyOtherKeys (`CSI > 4 ; 2 m`).
 * iTerm2 answers Shift+Enter with the kitty form `CSI 13 ; 2 u`, which claude reads as "insert a
 * newline". xterm.js sends a bare CR for Shift+Enter, which would submit the prompt. Verified
 * against claude 2.1.296 with tests/tools (CSI u, modifyOtherKeys and ESC CR all insert a newline).
 */
export const SHIFT_ENTER = '\x1b[13;2u';

/** Ctrl+V. claude reads an image off the system clipboard when it receives this byte. */
export const CTRL_V = '\x16';

export interface KeyContext {
  /** Write bytes (a JS string, sent as UTF-8) to the session. */
  send(data: string): void;
  hasSelection(): boolean;
  copySelection(): void;
  selectAll(): void;
}

/**
 * xterm `attachCustomKeyEventHandler` body. Returns false when the event was consumed here and
 * xterm must not process it. Everything not listed passes through untouched, so Esc, Esc-Esc,
 * Shift+Tab, Ctrl+C, Ctrl+R, Ctrl+O, arrows and digits reach claude exactly as xterm encodes them.
 */
export function handleKey(ev: KeyboardEvent, ctx: KeyContext): boolean {
  if (ev.type !== 'keydown' || ev.isComposing) return true;

  if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault();
    ctx.send(SHIFT_ENTER);
    return false;
  }

  if (ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
    if (ev.key === 'c' && ctx.hasSelection()) {
      ev.preventDefault();
      ctx.copySelection();
      return false;
    }
    if (ev.key === 'a') {
      ev.preventDefault();
      ctx.selectAll();
      return false;
    }
  }
  return true;
}

/** Quote a path for a shell the way iTerm2 does when a file is dropped on a terminal. */
export function shellQuotePath(path: string): string {
  return path.replace(/([^A-Za-z0-9_\-.,:/@%+=~])/g, '\\$1');
}
