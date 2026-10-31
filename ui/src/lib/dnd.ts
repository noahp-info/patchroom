/**
 * Pointer-driven drag for the sidebar. HTML5 drag and drop is unreliable in the Tauri webview
 * (the window's file-drop handler claims drags), so this uses pointer events only.
 */
export interface DragSpec {
  /** Pixels the pointer must travel before a press becomes a drag. */
  threshold?: number;
  onStart(): void;
  /** `under` is the element below the pointer, never the drag ghost. */
  onMove(x: number, y: number, under: Element | null): void;
  /** `committed` is false when the drag was cancelled with Escape. */
  onEnd(x: number, y: number, under: Element | null, committed: boolean): void;
}

const underPointer = (x: number, y: number): Element | null => document.elementFromPoint(x, y);

/** Call from `onPointerDown`. Returns nothing; the gesture cleans itself up. */
export function beginDrag(
  down: { clientX: number; clientY: number; button: number },
  spec: DragSpec,
) {
  if (down.button !== 0) return;
  const threshold = spec.threshold ?? 5;
  let started = false;
  const x0 = down.clientX;
  const y0 = down.clientY;

  const move = (e: PointerEvent) => {
    if (!started) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < threshold) return;
      started = true;
      document.body.classList.add('dragging');
      spec.onStart();
    }
    spec.onMove(e.clientX, e.clientY, underPointer(e.clientX, e.clientY));
  };
  const finish = (e: PointerEvent | null, committed: boolean) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('keydown', key, true);
    if (!started) return;
    document.body.classList.remove('dragging');
    // The click that ends a drag must not activate the row it ended on.
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    const x = e?.clientX ?? x0;
    const y = e?.clientY ?? y0;
    spec.onEnd(x, y, underPointer(x, y), committed);
  };
  const up = (e: PointerEvent) => finish(e, true);
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      finish(null, false);
    }
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('keydown', key, true);
}
