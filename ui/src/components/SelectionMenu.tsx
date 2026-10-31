import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../lib/clipboard';
import { cleanQuote } from '../lib/comments';
import type { AppStore } from '../state/store';
import { appRoot, ContextMenu, type MenuItem } from './Floating';
import { Icon } from './Icon';

/** Where native editing keeps its own menu and keys: text fields and the terminal. */
const NATIVE = 'input, textarea, select, [contenteditable="true"], .xterm';

interface Picked {
  text: string;
  /** The chat row the selection starts in, when it is one. */
  key: string | null;
  /** Offset of the selection in the row's text, so the exact words can be marked again. */
  at?: number;
}

/** The current page selection, or null when nothing (or only whitespace) is selected. */
function picked(): Picked | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString();
  if (text.trim() === '') return null;
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (el?.closest(NATIVE)) return null;
  const row = el?.closest<HTMLElement>('.chat [data-key]');
  if (!row) return { text, key: null };
  const r = sel.getRangeAt(0);
  const head = document.createRange();
  head.setStart(row, 0);
  head.setEnd(r.startContainer, r.startOffset);
  return { text, key: row.dataset.key ?? null, at: head.toString().length };
}

/**
 * Highlight-to-comment, app-wide. Selecting text in the chat shows a small Comment / Copy chip
 * by the selection; right-clicking any selection opens Comment, Copy and Search. Text fields
 * and the terminal keep their native menus. Cmd+C, drag-select and Select All are never
 * intercepted. Comment adds a line to the open DM's composer; nothing sends before Send.
 */
export function SelectionMenu({ store, activeId }: { store: AppStore; activeId: string | null }) {
  const [menu, setMenu] = useState<{ x: number; y: number; pick: Picked } | null>(null);
  const [link, setLink] = useState<{ x: number; y: number; href: string } | null>(null);
  const [chip, setChip] = useState<{ x: number; y: number; pick: Picked } | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);

  const comment = (pick: Picked) => {
    if (!activeId) return;
    store.chat(activeId).addComment(pick.key, cleanQuote(pick.text), pick.at, pick.text.length);
    window.getSelection()?.removeAllRanges();
    setChip(null);
  };

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(NATIVE)) return;
      const pick = picked();
      const a = target?.closest('a[href]');
      const href = a?.getAttribute('href') ?? '';
      if (!pick && /^https?:\/\//i.test(href)) {
        e.preventDefault();
        setChip(null);
        setLink({ x: e.clientX, y: e.clientY, href });
        return;
      }
      if (!pick) return;
      e.preventDefault();
      setChip(null);
      setMenu({ x: e.clientX, y: e.clientY, pick });
    };
    // The chip shows once a drag-select ends inside the chat log, never while it is dragging.
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (chipRef.current?.contains(e.target as Node)) return;
      window.setTimeout(() => {
        const pick = picked();
        const sel = window.getSelection();
        if (!pick || !pick.key || !sel?.rangeCount) {
          setChip(null);
          return;
        }
        const r = sel.getRangeAt(0).getBoundingClientRect();
        setChip({ x: r.left + r.width / 2, y: r.top, pick });
      }, 0);
    };
    const onSelChange = () => {
      if (!window.getSelection()?.toString().trim()) setChip(null);
    };
    const hide = () => setChip(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChip(null);
    };
    document.addEventListener('contextmenu', onContext);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('selectionchange', onSelChange);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('contextmenu', onContext);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('selectionchange', onSelChange);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const items = (pick: Picked): MenuItem[] => {
    const short = pick.text.trim().replace(/\s+/g, ' ');
    return [
      { label: 'Comment', onSelect: () => comment(pick), disabled: !activeId },
      { label: 'Copy', onSelect: () => void copyText(pick.text) },
      {
        label: `Search for “${short.length > 24 ? `${short.slice(0, 24)}…` : short}”`,
        onSelect: () => store.searchFor(short.slice(0, 200)),
        separator: true,
      },
    ];
  };

  return (
    <>
      {link && (
        <ContextMenu
          anchor={{ x: link.x, y: link.y }}
          items={[
            {
              label: 'Open in Patchroom',
              onSelect: () => store.openLink(link.href, { target: 'patchroom' }),
            },
            {
              label: 'Open in browser',
              onSelect: () => store.openLink(link.href, { target: 'browser' }),
            },
            { label: 'Copy link', onSelect: () => void copyText(link.href), separator: true },
          ]}
          label="Link"
          onClose={() => setLink(null)}
        />
      )}
      {menu && (
        <ContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          items={items(menu.pick)}
          label="Selection"
          onClose={() => setMenu(null)}
        />
      )}
      {chip &&
        activeId &&
        createPortal(
          <div
            ref={chipRef}
            className="selchip"
            role="toolbar"
            aria-label="Selection"
            data-testid="selection-chip"
            style={{ left: chip.x, top: chip.y }}
            // Pressing a button must not clear the selection it acts on.
            onMouseDown={(e) => e.preventDefault()}
          >
            <button type="button" data-testid="selchip-comment" onClick={() => comment(chip.pick)}>
              <Icon name="chat" />
              Comment
            </button>
            <button
              type="button"
              data-testid="selchip-copy"
              onClick={() => {
                void copyText(chip.pick.text);
                setChip(null);
              }}
            >
              <Icon name="copy" />
              Copy
            </button>
          </div>,
          appRoot(),
        )}
    </>
  );
}
