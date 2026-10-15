import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ViewerRect } from '../ipc';
import type { AppStore, ViewerState } from '../state/store';
import { Icon } from './Icon';

const rectOf = (el: HTMLElement): ViewerRect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

/**
 * The in-app link viewer: a pane on the right with its own toolbar. The page itself is a native
 * webview the backend lays over `.viewer__page`, so the pane reports that box on every change.
 */
export function ViewerPane({ store, viewer }: { store: AppStore; viewer: ViewerState }) {
  const page = useRef<HTMLDivElement>(null);
  const ipc = store.ipc;

  // Navigate once per open request, not when the page itself navigates.
  useLayoutEffect(() => {
    const el = page.current;
    if (!el) return;
    void ipc.viewerShow(viewer.url, rectOf(el)).catch((err: unknown) => {
      store.reportError(`Could not open the link here: ${String(err)}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer.req]);

  // Follow the pane as the window, sidebar or pane resize.
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const place = () => void ipc.viewerPlace(rectOf(el)).catch(() => undefined);
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [ipc]);

  let host = viewer.url;
  try {
    host = new URL(viewer.url).host;
  } catch {
    // Keep the raw text.
  }

  return (
    <aside className="viewer" aria-label="Link viewer" data-testid="viewer">
      <div className="viewer__bar">
        <button
          type="button"
          className="ib"
          aria-label="Back"
          title="Back"
          onClick={() => void ipc.viewerGo('back')}
        >
          <span className="flip">
            <Icon name="chev" />
          </span>
        </button>
        <button
          type="button"
          className="ib"
          aria-label="Forward"
          title="Forward"
          onClick={() => void ipc.viewerGo('forward')}
        >
          <Icon name="chev" />
        </button>
        <button
          type="button"
          className="ib"
          aria-label="Reload"
          title="Reload"
          onClick={() => void ipc.viewerGo('reload')}
        >
          <Icon name="resume" />
        </button>
        <div className="viewer__title" title={viewer.url}>
          <b data-testid="viewer-title">{viewer.title || host}</b>
          <span>{host}</span>
        </div>
        <button
          type="button"
          className="viewer__ext"
          data-testid="viewer-browser"
          title="Open this page in your default browser"
          onClick={() => store.viewerToBrowser()}
        >
          Open in browser
        </button>
        <button
          type="button"
          className="ib"
          aria-label="Close viewer"
          title="Close the viewer"
          data-testid="viewer-close"
          onClick={() => store.closeViewer()}
        >
          <Icon name="x" />
        </button>
      </div>
      <div ref={page} className="viewer__page" data-loading={viewer.loading ? 'true' : undefined}>
        {/* The native webview covers this box. It shows only before the page draws. */}
        <span className="viewer__wait">Loading {host}…</span>
      </div>
    </aside>
  );
}
