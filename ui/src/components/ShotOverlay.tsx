import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppStore, ShotState } from '../state/store';
import { useOverlay } from '../state/overlays';
import { Icon } from './Icon';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smallest box that counts as a selection, in CSS px. A click without a drag is not one. */
const MIN_BOX = 8;
const NOTE_W = 300;

const boxOf = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

/**
 * Screenshot-to-steer (SPEC 3.2). The window is frozen as a picture (the backend captured it),
 * the person drags a box over any part of it, side pane included, and a note box pins to the
 * box. Check adds the crop and the note to the composer as one line. X, Esc or a click outside
 * discards both. Nothing sends before Send.
 */
export function ShotOverlay({ store, shot }: { store: AppStore; shot: ShotState }) {
  useOverlay('screenshot');
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [done, setDone] = useState(false);
  const [note, setNote] = useState('');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [notePos, setNotePos] = useState<{ left: number; top: number } | null>(null);

  // Esc cancels at any step. Captured first, so no other handler sees it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      store.cancelShot();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [store]);

  // The note box pins below the box, or above it, or inside it, and stays in the window.
  useLayoutEffect(() => {
    if (!done || !box) return;
    const h = noteRef.current?.closest<HTMLElement>('.shot__note')?.offsetHeight ?? 120;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = box.y + box.height + 8;
    if (top + h > vh - 8) top = box.y - h - 8;
    if (top < 8) top = Math.min(vh - h - 8, box.y + 8);
    const left = Math.max(8, Math.min(box.x, vw - NOTE_W - 8));
    setNotePos({ left, top });
  }, [done, box]);
  // Focus once the box is placed: a hidden field cannot take focus.
  useEffect(() => {
    if (notePos) noteRef.current?.focus();
  }, [notePos]);

  const check = () => {
    if (box) void store.commitShot(box, note);
  };

  return (
    <div
      className="shot"
      role="dialog"
      aria-label="Screenshot to steer"
      data-testid="shot"
      data-step={done ? 'note' : 'drag'}
      onPointerDown={(e) => {
        if (done || e.button !== 0) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        setStart({ x: e.clientX, y: e.clientY });
        setBox({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
      }}
      onPointerMove={(e) => {
        if (done || !start) return;
        setBox(boxOf(start, { x: e.clientX, y: e.clientY }));
      }}
      onPointerUp={(e) => {
        if (done || !start) return;
        const b = boxOf(start, { x: e.clientX, y: e.clientY });
        setStart(null);
        if (b.width < MIN_BOX || b.height < MIN_BOX) {
          setBox(null);
          return;
        }
        setBox(b);
        setDone(true);
      }}
    >
      {shot.dataUrl && (
        <img
          className="shot__frame"
          src={shot.dataUrl}
          alt=""
          style={{ width: shot.width, height: shot.height }}
          draggable={false}
        />
      )}
      {!box && (
        <p className="shot__help" role="status">
          Drag over the part you want to point at. Esc cancels.
        </p>
      )}
      {box && (
        <div
          className="shot__box"
          data-testid="shot-box"
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        />
      )}
      {done && box && (
        <div
          className="shot__note"
          data-testid="shot-note"
          style={{
            left: notePos?.left ?? box.x,
            top: notePos?.top ?? box.y + box.height + 8,
            width: NOTE_W,
            visibility: notePos ? 'visible' : 'hidden',
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <textarea
            ref={noteRef}
            className="shot__input"
            rows={2}
            value={note}
            placeholder="What should Claude do about this?"
            aria-label="Steer note"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                check();
              }
            }}
          />
          <div className="shot__btns">
            <span className="shot__hint">Enter adds it. Nothing sends yet.</span>
            <button
              type="button"
              className="ib shot__x"
              aria-label="Discard screenshot"
              title="Discard (Esc)"
              onClick={() => store.cancelShot()}
            >
              <Icon name="x" />
            </button>
            <button
              type="button"
              className="ib shot__ok"
              aria-label="Add screenshot to message"
              title="Add to message (Enter)"
              onClick={check}
            >
              <Icon name="check" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
