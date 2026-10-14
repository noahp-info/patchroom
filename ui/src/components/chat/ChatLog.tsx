import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Row } from '../../lib/rows';
import { Icon } from '../Icon';
import { RowView, type RowActions } from './RowView';

const OVERSCAN = 500;
const NEAR_BOTTOM = 24;
const LOAD_OLDER_AT = 800;
const BOTTOM_PAD = 12;

/** Measured row heights by key. A class, so the hook rules see method calls, not mutation. */
class HeightCache {
  private readonly map = new Map<string, number>();
  get(key: string): number | undefined {
    return this.map.get(key);
  }
  /** True when the stored height changed. */
  set(key: string, h: number): boolean {
    const prev = this.map.get(key);
    if (prev !== undefined && Math.abs(prev - h) < 0.5) return false;
    this.map.set(key, h);
    return true;
  }
}

/** Height guess for a row that has not been measured yet. Rows are measured once on screen. */
function estimate(row: Row): number {
  if (row.type === 'day') return 36;
  if (row.type === 'prompt') return 200;
  const it = row.item;
  const head = row.head ? 42 : 4;
  switch (it.kind) {
    case 'user':
      return (
        head +
        22 *
          Math.min(12, 1 + Math.floor(it.text.length / 90) + (it.text.match(/\n/g)?.length ?? 0)) +
        12 +
        (it.images.length ? 110 : 0)
      );
    case 'assistant':
      return head + 22 * Math.min(40, 1 + Math.ceil(it.text.length / 85)) + 14;
    case 'thinking':
      return head + 30;
    case 'tool':
      return head + 44;
    case 'subagent':
      return head + 62;
    case 'question':
    case 'plan':
      return head + 160;
    case 'system':
    case 'fallback':
      return 34;
  }
}

export interface ScrollState {
  top: number;
  atBottom: boolean;
}

export interface ChatLogProps {
  rows: Row[];
  actions: RowActions;
  expanded: ReadonlySet<string>;
  initial: ScrollState;
  onScrollState(s: ScrollState): void;
  hasMore: boolean;
  loading: boolean;
  onLoadOlder(): void;
  label: string;
  testId?: string;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  /** Pending prompts below the viewport, for the jump pill. */
  waiting?: number;
}

function lowerBound(offs: Float64Array, n: number, target: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offs[mid + 1] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The row that pins the scroll position: the first row at or below the top edge, skipping day
 * dividers (their keys move when older rows arrive above them).
 */
function pickAnchor(
  rows: readonly Row[],
  offs: Float64Array,
  st: number,
): { key: string; top: number } | null {
  const n = rows.length;
  let i = lowerBound(offs, n, st);
  while (i < n && rows[i].type === 'day') i++;
  return i < n ? { key: rows[i].key, top: offs[i] - st } : null;
}

/**
 * Virtualized message log. Only rows near the viewport are in the DOM. Heights are measured on
 * screen and cached by row key. It sticks to the bottom only while the user is at the bottom,
 * and keeps the first visible row fixed when rows above change height or older pages arrive.
 */
export function ChatLog(props: ChatLogProps) {
  const { rows, actions, expanded, initial, onScrollState, hasMore, loading, onLoadOlder } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [heights] = useState(() => new HeightCache());
  const [tick, setTick] = useState(0);
  const [view, setView] = useState({
    top: initial.atBottom ? Number.MAX_SAFE_INTEGER : initial.top,
    h: 700,
  });
  const [atBottom, setAtBottom] = useState(initial.atBottom);
  const stick = useRef(initial.atBottom);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  /** The scrollTop at which `anchor` was recorded. The anchor is only trusted while it matches. */
  const anchorAt = useRef(0);
  const restored = useRef(false);
  /** scrollTop after the last layout pass, to tell a user scroll from content growth. */
  const lastTop = useRef(0);
  /** scrollHeight after the last layout pass: a log that got shorter clamps scrollTop by itself. */
  const lastHeight = useRef(0);

  const offs = useMemo(() => {
    const o = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++)
      o[i + 1] = o[i] + (heights.get(rows[i].key) ?? estimate(rows[i]));
    return o;
    // `tick` bumps when a measured height changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, heights, tick]);
  const total = offs[rows.length];
  const offsRef = useRef(offs);
  const rowsRef = useRef(rows);

  const top = Math.min(view.top, Math.max(0, total - view.h));
  const first = Math.max(0, lowerBound(offs, rows.length, top - OVERSCAN));
  let last = first;
  while (last < rows.length && offs[last] < top + view.h + OVERSCAN) last++;

  // ---- scroll handling ------------------------------------------------------------------
  const raf = useRef(0);
  const loadingRef = useRef(loading);
  const hasMoreRef = useRef(hasMore);
  // Event handlers read these; they are written after commit, never during render.
  useLayoutEffect(() => {
    offsRef.current = offs;
    rowsRef.current = rows;
    loadingRef.current = loading;
    hasMoreRef.current = hasMore;
  });

  const sync = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const o = offsRef.current;
    const st = el.scrollTop;
    const near = el.scrollHeight - st - el.clientHeight <= NEAR_BOTTOM;
    stick.current = near;
    setAtBottom((prev) => (prev === near ? prev : near));
    // Anchor: the first row whose bottom is below the top edge.
    const a = pickAnchor(rowsRef.current, o, st);
    if (a) {
      anchor.current = a;
      anchorAt.current = st;
    }
    onScrollState({ top: st, atBottom: near });
    if (st < LOAD_OLDER_AT && hasMoreRef.current && !loadingRef.current) onLoadOlder();
    setView((v) =>
      Math.abs(v.top - st) < 1 && v.h === el.clientHeight ? v : { top: st, h: el.clientHeight },
    );
  }, [onScrollState, onLoadOlder]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      // Anchor and stick state update at once; the render waits for the next frame.
      const o = offsRef.current;
      const st = el.scrollTop;
      stick.current = el.scrollHeight - st - el.clientHeight <= NEAR_BOTTOM;
      const a = pickAnchor(rowsRef.current, o, st);
      if (a) {
        anchor.current = a;
        anchorAt.current = st;
      }
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        sync();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // The viewport changed size (the status strip grew, the composer wrapped, the window
    // resized). A view that was pinned to the bottom stays pinned: re-pin before measuring, or
    // the smaller viewport would read as "scrolled up" and stop following new rows.
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      sync();
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [sync]);

  // ---- measurement ----------------------------------------------------------------------
  const rowObserver = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());
  const pendingTick = useRef(0);

  const measure = useCallback(
    (el: HTMLElement): boolean => {
      const key = el.dataset.rk;
      if (!key) return false;
      const h = el.offsetHeight;
      if (h === 0) return false;
      return heights.set(key, h);
    },
    [heights],
  );

  useEffect(() => {
    rowObserver.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) if (measure(e.target as HTMLElement)) changed = true;
      if (changed && !pendingTick.current) {
        pendingTick.current = requestAnimationFrame(() => {
          pendingTick.current = 0;
          setTick((t) => t + 1);
        });
      }
    });
    const seen = observed.current;
    return () => {
      rowObserver.current?.disconnect();
      rowObserver.current = null;
      seen.clear();
      if (pendingTick.current) cancelAnimationFrame(pendingTick.current);
    };
  }, [measure]);

  // Runs after every render on purpose: it measures, then places the scroll position.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const host = inner.current;
    const el = scroller.current;
    if (!host || !el) return;
    // Measure what rendered, observe it, forget what left.
    let changed = false;
    const now = new Set<Element>();
    for (const child of Array.from(host.children)) {
      now.add(child);
      if (measure(child as HTMLElement)) changed = true;
      if (!observed.current.has(child)) {
        rowObserver.current?.observe(child);
        observed.current.add(child);
      }
    }
    for (const old of Array.from(observed.current)) {
      if (!now.has(old)) {
        rowObserver.current?.unobserve(old);
        observed.current.delete(old);
      }
    }
    if (changed) {
      setTick((t) => t + 1);
      return;
    }
    // Layout is settled for this render: place the scroll position.
    if (!restored.current) {
      restored.current = true;
      if (initial.atBottom) el.scrollTop = el.scrollHeight;
      else el.scrollTop = initial.top;
      lastTop.current = el.scrollTop;
      lastHeight.current = el.scrollHeight;
      sync();
      return;
    }
    // The scroll event may not have fired yet, so the stick flag and the anchor can be stale.
    // Compare against where this component left the view, and where the anchor was taken.
    const maxTop = el.scrollHeight - el.clientHeight;
    if (stick.current) {
      // A log that got shorter makes the browser clamp scrollTop. That is not the user scrolling.
      const shrank = el.scrollHeight < lastHeight.current - 1;
      if (!shrank && el.scrollTop < Math.min(lastTop.current, maxTop) - 2) {
        // The user scrolled up before the event landed: stop following the bottom.
        stick.current = false;
        sync();
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) {
        el.scrollTop = el.scrollHeight;
        sync();
      }
    } else if (anchor.current) {
      if (Math.abs(el.scrollTop - anchorAt.current) > 2) {
        // Moved without an event yet: take the anchor where the view is now.
        stick.current = maxTop - el.scrollTop <= NEAR_BOTTOM;
        sync();
      } else {
        const idx = rows.findIndex((r) => r.key === anchor.current!.key);
        if (idx >= 0) {
          const want = offs[idx] - anchor.current.top;
          if (Math.abs(el.scrollTop - want) > 1) {
            el.scrollTop = want;
            sync();
          }
        }
      }
    }
    lastTop.current = el.scrollTop;
    lastHeight.current = el.scrollHeight;
  });

  // A short log with more history above: fetch until the viewport is full.
  useEffect(() => {
    if (hasMore && !loading && total < view.h + LOAD_OLDER_AT) onLoadOlder();
  }, [hasMore, loading, total, view.h, onLoadOlder]);

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    sync();
  };

  const rendered: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const row = rows[i];
    const head = row.type !== 'day' && row.head;
    rendered.push(
      <div
        key={row.key}
        className={`vrow${head ? ' head' : ''}${row.type === 'day' ? ' dayrow' : ''}`}
        data-rk={row.key}
      >
        <RowView row={row} expanded={expanded.has(row.key)} actions={actions} />
      </div>,
    );
  }

  return (
    <div className="logcol">
      <div className="logwrap">
        <div
          ref={scroller}
          className="vlog"
          role="region"
          aria-label={props.label}
          tabIndex={0}
          data-testid={props.testId ?? 'chat-log'}
          data-rows={rows.length}
          data-rendered={last - first}
        >
          <div
            ref={inner}
            className="vsize"
            style={{ paddingTop: offs[first], paddingBottom: total - offs[last] + BOTTOM_PAD }}
          >
            {rendered}
          </div>
        </div>
        {hasMore && (
          <div className="older" role="status">
            {loading ? 'Loading earlier messages' : 'Earlier messages'}
          </div>
        )}
        {rows.length === 0 && props.empty}
      </div>
      {!atBottom && rows.length > 0 && (
        <div className="jumpbar">
          <button
            type="button"
            className={`jump${props.waiting ? ' needs' : ''}`}
            onClick={jump}
            data-testid="jump-latest"
          >
            <Icon name="down2" />
            {props.waiting ? 'Needs you below' : 'Jump to latest'}
          </button>
        </div>
      )}
    </div>
  );
}
