import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme/index.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

function mount(el: HTMLElement): void {
  const r = createRoot(el);
  // Commit synchronously, so the app's key handlers exist as soon as the page has loaded.
  flushSync(() =>
    r.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
}

// The in-app e2e runner is bundled only when the UI is built with VITE_PR_E2E=1, and only
// installs inside the Tauri webview. Otherwise this branch is removed from the build.
if (import.meta.env.VITE_PR_E2E === '1' && '__TAURI_INTERNALS__' in window) {
  void import('./e2e/runner').then((m) => m.install()).finally(() => mount(root));
} else {
  mount(root);
}
