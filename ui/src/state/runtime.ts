import { createIpc } from '../ipc';
import { AppStore } from './store';

let store: AppStore | null = null;

/** `?grid=120x40` pins the terminal grid (tests); otherwise the terminal fits its pane. */
function fixedGrid(): { cols: number; rows: number } | undefined {
  const m = /^(\d+)x(\d+)$/.exec(new URLSearchParams(window.location.search).get('grid') ?? '');
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : undefined;
}

/** One store per page load, even under React StrictMode's double render. */
export function getStore(): AppStore {
  if (!store) {
    store = new AppStore(createIpc(), { fixedGrid: fixedGrid() });
    // Test hook: lets Playwright re-read the backend after seeding the mock.
    (window as unknown as { __PR_STORE__?: AppStore }).__PR_STORE__ = store;
  }
  return store;
}
