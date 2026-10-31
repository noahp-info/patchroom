import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 264;
const STEP = 16;
const STEP_BIG = 48;

export function clampSidebar(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

interface Props {
  width: number;
  /** Live width while dragging or pressing a key. */
  onPreview(w: number): void;
  /** Final width: persist it. */
  onCommit(w: number): void;
}

/**
 * The drag handle on the sidebar's right edge. A vertical separator the keyboard can focus:
 * arrows move it 16px (48 with Shift), Home and End jump to the limits, a double-click resets.
 * It sits just outside the sidebar so it never overlaps the Patch Bay cable's inner gutter.
 */
export function SidebarResizer({ width, onPreview, onCommit }: Props) {
  const start = useRef<{ x: number; w: number } | null>(null);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    e.preventDefault();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (s) onPreview(clampSidebar(s.w + e.clientX - s.x));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    start.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(clampSidebar(s.w + e.clientX - s.x));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP_BIG : STEP;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = width + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = width - step;
    else if (e.key === 'Home') next = SIDEBAR_MIN;
    else if (e.key === 'End') next = SIDEBAR_MAX;
    else if (e.key === 'Enter') next = SIDEBAR_DEFAULT;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onCommit(clampSidebar(next));
  };

  return (
    <div
      className="side-resizer"
      data-testid="side-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        onPreview(width);
      }}
      onDoubleClick={() => onCommit(SIDEBAR_DEFAULT)}
      onKeyDown={key}
    />
  );
}
