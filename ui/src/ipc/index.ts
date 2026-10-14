import { createMockIpc } from './mock';
import { createTauriIpc } from './tauri';
import type { Ipc } from './types';

export type { Ipc, Needs, SectionInfo, SessionInfo, SessionStatus } from './types';

/** True inside the Tauri webview. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Pick the backend. `?mock` forces the mock (Playwright, browser dev). Outside Tauri the mock is
 * the fallback so `pnpm dev` in a browser still renders.
 */
export function createIpc(): Ipc {
  const params = new URLSearchParams(window.location.search);
  if (inTauri() && !params.has('mock')) return createTauriIpc();
  const { ipc, control } = createMockIpc({ banner: true });
  window.__PR_MOCK__ = control;
  return ipc;
}
