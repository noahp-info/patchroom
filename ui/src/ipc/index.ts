import { createMockIpc, type MockControl } from './mock';
import { seedSidebarDemo } from './sidebarDemo';
import { createTauriIpc } from './tauri';
import type { Ipc } from './types';

export type * from './types';

/**
 * `?mock&demo` opens with one DM that holds the synthetic transcript, a pending permission prompt,
 * a statusLine and chips. For screenshots and design review (the impeccable detector scans it).
 */
function seedDemo(control: MockControl): void {
  const s = control.addSession({
    cwd: '/Users/me/code/patchroom',
    name: 'hook-bridge',
    status: 'busy',
  });
  control.seedChat(s.id, control.synthetic());
  window.setTimeout(() => {
    control.setStatusline(
      s.id,
      '\x1b[32mpatchroom\x1b[0m \x1b[2mon\x1b[0m \x1b[33mfeat/hook-bridge\x1b[0m  \x1b[1m42 tests ok\x1b[0m',
      {
        model: 'Opus 4.8',
        contextPct: 64,
        cost: 1.82,
        mode: 'accept edits',
        worktree: 'wt/hook-bridge',
        prUrl: 'https://github.com/acme/patchroom/pull/14',
      },
    );
    control.emitPrompt(s.id, {
      promptId: 'demo-perm',
      kind: 'permission',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build && cargo build' },
    });
  }, 400);
}

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
  const { ipc, control } = createMockIpc({ banner: true, persist: params.has('persist') });
  window.__PR_MOCK__ = control;
  if (params.has('demo')) seedDemo(control);
  if (params.has('sidebar-demo')) seedSidebarDemo(control);
  // `soundhooks=Stop,SessionStart`: the person's own sound hooks, as a wrapper script.
  for (const event of (params.get('soundhooks') ?? '').split(',').filter(Boolean)) {
    control.soundHooks.push({
      event,
      command: `$HOME/.claude/sounds/play.sh ${event.toLowerCase()}`,
      source: 'user',
      script: '$HOME/.claude/sounds/play.sh',
      guarded: false,
    });
  }
  return ipc;
}
