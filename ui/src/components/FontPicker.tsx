import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { familyStack, listFonts, type FontOption } from '../theme/typeface';
import { Floating } from './Floating';

/**
 * A font family field. The button shows the choice in its own face; an unset field shows the
 * inherited family, muted, with where it comes from. The list previews every family in its
 * own face: a Default entry, the faces bundled with Patchroom, then the Mac's installed ones.
 */
export function FontPicker({
  value,
  inherited,
  inheritedFrom,
  mono,
  label,
  container,
  testId,
  onChange,
}: {
  /** The chosen family, or undefined to inherit. */
  value: string | undefined;
  /** What an unset field draws in. */
  inherited: string;
  /** Where the inherited family comes from, for the muted suffix ("from UI"). */
  inheritedFrom: string;
  /** Offer fixed-pitch families only. */
  mono: boolean;
  /** Accessible name of the field. */
  label: string;
  /** Portal target: the Settings dialog, so the list sits in its top layer. */
  container?: HTMLElement | null;
  testId?: string;
  onChange(family: string | undefined): void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const shown = value ?? inherited;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="fpick"
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-label={`${label}: ${value ?? `${inherited}, ${inheritedFrom}`}`}
        data-testid={testId}
        data-set={value ? 'true' : undefined}
        onClick={(e) => {
          if (anchor) return setAnchor(null);
          setHost(container ?? e.currentTarget.closest('dialog'));
          setAnchor(e.currentTarget.getBoundingClientRect());
        }}
      >
        <span className="fpick__face" style={{ fontFamily: familyStack(shown, mono) }}>
          <span>{shown}</span>
        </span>
        {!value && (
          <span className="fpick__from">
            <span>{inheritedFrom}</span>
          </span>
        )}
        <span className="fpick__chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {anchor && (
        <FontList
          anchor={anchor}
          container={host}
          label={label}
          mono={mono}
          value={value}
          inherited={inherited}
          onPick={(f) => {
            setAnchor(null);
            onChange(f);
            btn.current?.focus();
          }}
          onClose={() => {
            setAnchor(null);
            btn.current?.focus();
          }}
        />
      )}
    </>
  );
}

const DEFAULT_KEY = '\u0000default';

function FontList({
  anchor,
  container,
  label,
  ...body
}: {
  anchor: DOMRect;
  container: HTMLElement | null;
  label: string;
  mono: boolean;
  value: string | undefined;
  inherited: string;
  onPick(family: string | undefined): void;
  onClose(): void;
}) {
  return (
    <Floating
      anchor={anchor}
      onClose={body.onClose}
      label={label}
      className="flist"
      container={container}
    >
      <FontChooser label={label} {...body} />
    </Floating>
  );
}

/**
 * The filter field and the family list, each family in its own face: Default first, then the
 * bundled faces, then the installed ones. Arrow keys move, Enter picks.
 */
export function FontChooser({
  label,
  mono,
  value,
  inherited,
  onPick,
}: {
  label: string;
  mono: boolean;
  value: string | undefined;
  inherited: string;
  onPick(family: string | undefined): void;
}) {
  const uid = useId();
  const [all, setAll] = useState<FontOption[] | null>(null);
  const [q, setQ] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // The surface stays hidden until it is placed, and a hidden field cannot take focus.
  useEffect(() => {
    const raf = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    let live = true;
    void listFonts().then((f) => live && setAll(f));
    return () => {
      live = false;
    };
  }, []);

  const opts = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (all ?? []).filter(
      (f) => (!mono || f.mono) && (!t || f.family.toLowerCase().includes(t)),
    );
  }, [all, q, mono]);
  const bundled = opts.filter((f) => f.bundled);
  const installed = opts.filter((f) => !f.bundled);
  const keys = [...(q.trim() ? [] : [DEFAULT_KEY]), ...opts.map((f) => f.family)];
  const [active, setActive] = useState<string>(value ?? DEFAULT_KEY);
  const at = Math.max(0, keys.indexOf(active));
  const activeKey = keys[at];

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeKey ?? '')}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeKey]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = keys.length;
      if (!n) return;
      setActive(keys[(at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeKey) onPick(activeKey === DEFAULT_KEY ? undefined : activeKey);
    }
  };
  const optId = (k: string) => `${uid}-${keys.indexOf(k)}`;
  const row = (f: FontOption) => (
    <div
      key={f.family}
      id={optId(f.family)}
      role="option"
      aria-selected={value === f.family}
      data-key={f.family}
      data-active={activeKey === f.family ? 'true' : undefined}
      className="flist__opt"
      style={{ fontFamily: familyStack(f.family, f.mono) }}
      onMouseMove={() => setActive(f.family)}
      onClick={() => onPick(f.family)}
    >
      {f.family}
    </div>
  );

  return (
    <>
      <input
        ref={field}
        className="flist__q"
        type="search"
        value={q}
        placeholder={mono ? 'Filter fixed-pitch fonts' : 'Filter fonts'}
        aria-label={`Filter ${label}`}
        aria-controls={`${uid}-list`}
        aria-activedescendant={activeKey ? optId(activeKey) : undefined}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
      />
      <div ref={list} id={`${uid}-list`} role="listbox" aria-label={label} className="flist__list">
        {!q.trim() && (
          <div
            id={optId(DEFAULT_KEY)}
            role="option"
            aria-selected={value === undefined}
            data-key={DEFAULT_KEY}
            data-active={activeKey === DEFAULT_KEY ? 'true' : undefined}
            className="flist__opt"
            style={{ fontFamily: familyStack(inherited, mono) }}
            onMouseMove={() => setActive(DEFAULT_KEY)}
            onClick={() => onPick(undefined)}
          >
            Default ({inherited})
          </div>
        )}
        {bundled.length > 0 && (
          <div role="group" aria-label="Bundled with Patchroom">
            <div className="flist__h" aria-hidden="true">
              Bundled with Patchroom
            </div>
            {bundled.map(row)}
          </div>
        )}
        {installed.length > 0 && (
          <div role="group" aria-label="On this Mac">
            <div className="flist__h" aria-hidden="true">
              On this Mac
            </div>
            {installed.map(row)}
          </div>
        )}
        {all === null && <p className="flist__empty">Reading fonts...</p>}
        {all !== null && opts.length === 0 && (
          <p className="flist__empty">No {mono ? 'fixed-pitch ' : ''}fonts match.</p>
        )}
      </div>
    </>
  );
}
