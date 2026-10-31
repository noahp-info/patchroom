import { useEffect, useState } from 'react';

/** Browser and e2e seam: dispatch `new CustomEvent(FULLSCREEN_EVENT, { detail: true })`. */
export const FULLSCREEN_EVENT = 'pr:fullscreen';

/**
 * True while the main window is full screen. macOS hides the window controls then, so the top
 * bar drops the inset it keeps for them. In Tauri the window reports it; elsewhere the page
 * listens for FULLSCREEN_EVENT (tests drive that).
 */
export function useFullscreen(): boolean {
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onEvent = (e: Event) => setFull(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener(FULLSCREEN_EVENT, onEvent);
    return () => window.removeEventListener(FULLSCREEN_EVENT, onEvent);
  }, []);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let off: (() => void) | undefined;
    let gone = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const sync = () => void w.isFullscreen().then((f) => !gone && setFull(f));
      sync();
      const un = await w.onResized(sync);
      if (gone) un();
      else off = un;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  return full;
}
