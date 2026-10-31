import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewerRect } from '../ipc';
import type { AppStore, ViewerState } from '../state/store';
import { Icon } from './Icon';

const rectOf = (el: HTMLElement): ViewerRect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

/** Wait until the picture is decoded and painted, so hiding the native view never flashes. */
async function painted(img: HTMLImageElement | null): Promise<void> {
  try {
    await img?.decode();
  } catch {
    // A picture that fails to decode still leaves the pane's ground, never a hole.
  }
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

/**
 * The in-app link viewer: a pane on the right with its own toolbar. The page itself is a native
 * webview the backend lays over `.viewer__page`, so the pane reports that box on every change.
 *
 * Native views draw above all HTML. While an overlay is open (`covered`), the pane shows a
 * frozen picture of the page and the native view hides; it comes back when the last overlay
 * closes.
 */
export function ViewerPane({
  store,
  viewer,
  covered,
}: {
  store: AppStore;
  viewer: ViewerState;
  covered: boolean;
}) {
  const page = useRef<HTMLDivElement>(null);
  const frozen = useRef<HTMLImageElement>(null);
  const [still, setStill] = useState<string | null>(null);
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

  // Freeze under overlays: picture first, then hide; on close, show first, then drop the picture.
  const gen = useRef(0);
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const mine = ++gen.current;
    if (covered) {
      void (async () => {
        const shot = await ipc.viewerSnapshot(rectOf(el)).catch(() => null);
        if (gen.current !== mine) return;
        if (shot) {
          setStill(shot);
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          await painted(frozen.current);
        }
        if (gen.current === mine) await ipc.viewerHide().catch(() => undefined);
      })();
    } else {
      void (async () => {
        await ipc.viewerReveal(rectOf(el)).catch(() => undefined);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (gen.current === mine) setStill(null);
      })();
    }
  }, [covered, ipc]);

  let host = viewer.url;
  try {
    host = new URL(viewer.url).host;
  } catch {
    // Keep the raw text.
  }

  return (
    <aside
      className="viewer"
      aria-label="Link viewer"
      data-testid="viewer"
      data-frozen={still ? 'true' : undefined}
    >
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
          className="ib viewer__opt"
          aria-label="Forward"
          title="Forward"
          onClick={() => void ipc.viewerGo('forward')}
        >
          <Icon name="chev" />
        </button>
        <button
          type="button"
          className="ib viewer__opt"
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
          className="ib"
          aria-label="Comment on selection"
          title={'Comment on the text selected in this page (⌘⇧M)'}
          data-testid="viewer-comment"
          onClick={() => store.commentOnSelection()}
        >
          <Icon name="comment" />
        </button>
        <button
          type="button"
          className="viewer__ext"
          data-testid="viewer-browser"
          aria-label="Open in browser"
          title="Open this page in your default browser"
          onClick={() => store.viewerToBrowser()}
        >
          <Icon name="ext" />
          <span className="viewer__ext-label">Open in browser</span>
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
      {viewer.signIn && (
        <div className="viewer__signin" role="status" data-testid="viewer-signin">
          <span>
            Sign in to claude.ai once, here in Patchroom. Artifacts then open in this pane until
            claude.ai ends the sign-in.
          </span>
          <button type="button" className="btn pri" onClick={() => store.signInClaude()}>
            Sign in
          </button>
        </div>
      )}
      <div ref={page} className="viewer__page" data-loading={viewer.loading ? 'true' : undefined}>
        {/* The native webview covers this box. It shows only before the page draws. */}
        <span className="viewer__wait">Loading {host}…</span>
        {still && (
          <img
            ref={frozen}
            className="viewer__still"
            src={still}
            alt=""
            data-testid="viewer-still"
          />
        )}
      </div>
    </aside>
  );
}
