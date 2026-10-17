import { useSyncExternalStore } from 'react';

/**
 * Accounts the side-pane viewer is signed in to. Today: claude.ai. The viewer keeps its own web
 * storage, so a sign-in there lasts until claude.ai expires it. Patchroom never reads cookies:
 * the state comes from which claude.ai page last loaded (`viewer:account`), and is only as fresh
 * as that page. It lives in this window's localStorage as a convenience, never in the database.
 */
export interface AccountState {
  /** True or false once a claude.ai page said so; null before any did. */
  signedIn: boolean | null;
  /** When that page loaded (epoch ms). */
  at: number | null;
}

/** What Settings > Accounts can do. The app store binds the real actions at start. */
export interface AccountActions {
  /** Open claude.ai's sign-in page in the side pane. */
  signIn(): void;
  /** Clear the viewer's claude.ai sign-in. Resolves to a sentence for the status line. */
  signOut(): Promise<string>;
}

const KEY = 'patchroom.account.claude';
const listeners = new Set<() => void>();

function read(): AccountState {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<AccountState>;
    if (v && typeof v === 'object') {
      return {
        signedIn: typeof v.signedIn === 'boolean' ? v.signedIn : null,
        at: typeof v.at === 'number' ? v.at : null,
      };
    }
  } catch {
    // Storage can be blocked; the state then lasts until the app quits.
  }
  return { signedIn: null, at: null };
}

let state: AccountState = read();
let actions: AccountActions = {
  signIn() {},
  signOut: async () => 'Signing in happens in the app.',
};

export function claudeAccount(): AccountState {
  return state;
}

export function setClaudeAccount(signedIn: boolean | null, at: number | null = Date.now()): void {
  state = { signedIn, at: signedIn === null ? null : at };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // See read().
  }
  for (const fn of listeners) fn();
}

export function bindAccountActions(a: AccountActions): void {
  actions = a;
}

export function accountActions(): AccountActions {
  return actions;
}

export function useClaudeAccount(): AccountState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}
