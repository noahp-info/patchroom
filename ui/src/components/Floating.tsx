import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from '../state/overlays';

export type Anchor = { x: number; y: number } | DOMRect;

export interface FloatingProps {
  /** A pointer position, or the rect of the control it opens from. */
  anchor: Anchor;
  onClose(): void;
  children: ReactNode;
  className?: string;
  label: string;
  role?: string;
  /** Where to portal: a modal dialog's own element, so the surface is not behind its top layer. */
  container?: HTMLElement | null;
}

const isRect = (a: Anchor): a is DOMRect => 'width' in a;

/** The themed root, so portaled UI keeps the theme variables. */
export function appRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('.pr-app') ?? document.body;
}

/** A fixed-position surface that stays inside the window and closes on Esc or an outside press. */
export function Floating({
  anchor,
  onClose,
  children,
  className,
  label,
  role,
  container,
}: FloatingProps) {
  // Menus and pickers draw over the side pane: the native viewer steps aside while one is open.
  useOverlay(`floating:${label}`);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.scrollHeight + 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Never over the window's title bar: that is chrome, and its drag region.
    const tb = document.querySelector('[data-testid="topbar"]')?.getBoundingClientRect();
    const minTop = Math.max(8, (tb?.bottom ?? 0) + 4);
    let left = isRect(anchor) ? anchor.left : anchor.x;
    let top = isRect(anchor) ? anchor.bottom + 4 : anchor.y;
    let maxHeight: number | undefined;
    if (isRect(anchor) && top + h > vh - 8) {
      const below = vh - 8 - (anchor.bottom + 4);
      const above = anchor.top - 4 - minTop;
      if (h <= above) top = anchor.top - h - 4;
      else if (above > below) {
        // Too tall for either side: take the roomier one and scroll inside.
        top = minTop;
        maxHeight = above;
      } else maxHeight = below;
    }
    if (left + w > vw - 8) left = vw - w - 8;
    if (maxHeight === undefined && top + h > vh - 8) top = vh - h - 8;
    setPos({ left: Math.max(8, left), top: Math.max(minTop, top), maxHeight });
  }, [anchor]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close.current();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close.current();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);

  return createPortal(
    <div
      ref={box}
      className={`floating ${className ?? ''}`}
      role={role ?? 'dialog'}
      aria-label={label}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        ...(pos?.maxHeight !== undefined ? { maxHeight: pos.maxHeight } : {}),
      }}
    >
      {children}
    </div>,
    container ?? appRoot(),
  );
}

export interface MenuItem {
  label: string;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separator?: boolean;
}

/** Right-click menu with arrow-key navigation. */
export function ContextMenu({
  anchor,
  items,
  label,
  onClose,
}: {
  anchor: Anchor;
  items: MenuItem[];
  label: string;
  onClose(): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The surface stays hidden until it is placed, and a hidden button cannot take focus.
    const raf = requestAnimationFrame(() =>
      list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
    );
    return () => cancelAnimationFrame(raf);
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const btns = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const at = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? btns.length - 1
          : (at + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns[next]?.focus();
  };

  return (
    <Floating anchor={anchor} onClose={onClose} label={label} role="menu" className="ctxmenu">
      <div ref={list} onKeyDown={onKey}>
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={`ctxmenu__item${it.danger ? ' danger' : ''}${it.separator ? ' sep' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </Floating>
  );
}
