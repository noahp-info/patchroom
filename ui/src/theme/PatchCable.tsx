import { useLayoutEffect, useRef } from 'react';
import { cablePath } from './cable.ts';

/** Distance from the sidebar's right edge to the cable's vertical run, in CSS px. */
const CHANNEL_INSET = 4;

interface Props {
  /** Selector for the plug at the active row. */
  from?: string;
  /** Selector for the plug at the conversation header. */
  to?: string;
  /** Change this when anything that moves the plugs changes (base, theme, mode). */
  remeasureKey?: string;
}

/**
 * Patch Bay's one live cable. Mount it as a direct child of the `.pr-app` root; it measures there. It hides itself on every other base through CSS (`.cable` is
 * `display: none` there), so mounting it on any base is safe. Geometry is written straight to the
 * SVG, not through state, so a resize never re-renders the app.
 */
export function PatchCable({
  from = '.row.active .jack',
  to = '[data-jack-to]',
  remeasureKey,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const el = svg.current;
    const root = el?.parentElement;
    if (!root || !el) return;
    void remeasureKey;
    let alive = true;

    const measure = () => {
      if (!alive) return;
      const a = root.querySelector(from);
      const b = root.querySelector(to);
      if (!a || !b || getComputedStyle(el).display === 'none') return;
      // A row scrolled out of the sidebar has no plug to show: hide the cable rather than draw it over content.
      const list = root.querySelector('.side-scroll')?.getBoundingClientRect();
      const aq = a.getBoundingClientRect();
      const visible = !list || (aq.top >= list.top && aq.bottom <= list.bottom);
      el.style.visibility = visible ? '' : 'hidden';
      if (!visible) return;
      const r = root.getBoundingClientRect();
      const k = r.width / root.offsetWidth || 1;
      const centre = (n: Element) => {
        const q = n.getBoundingClientRect();
        return { x: (q.left - r.left + q.width / 2) / k, y: (q.top - r.top + q.height / 2) / k };
      };
      const p1 = centre(a);
      const p2 = centre(b);
      // The channel is the padding strip at the sidebar's inner right edge: no sidebar text
      // reaches it and no conversation content starts before it.
      const side = root.querySelector('.side')?.getBoundingClientRect();
      const channelX = side ? (side.right - r.left) / k - CHANNEL_INSET : p1.x;
      const d = cablePath(p1, p2, channelX);
      el.querySelectorAll('path').forEach((p) => p.setAttribute('d', d));
      const dots = el.querySelectorAll('circle');
      dots[0]?.setAttribute('cx', String(p1.x));
      dots[0]?.setAttribute('cy', String(p1.y));
      dots[1]?.setAttribute('cx', String(p2.x));
      dots[1]?.setAttribute('cy', String(p2.y));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    const side = root.querySelector('.side');
    if (side) ro.observe(side);
    const rows = root.querySelector('.side-scroll') ?? side;
    rows?.addEventListener('scroll', measure, { passive: true });
    const mo = new MutationObserver(measure);
    if (side)
      mo.observe(side, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    void document.fonts?.ready.then(measure);
    return () => {
      alive = false;
      ro.disconnect();
      mo.disconnect();
      rows?.removeEventListener('scroll', measure);
    };
  }, [from, to, remeasureKey]);

  return (
    <svg ref={svg} className="cable" aria-hidden="true">
      <path
        fill="none"
        stroke="rgb(0 0 0 / .22)"
        strokeWidth="7"
        strokeLinecap="round"
        transform="translate(0 3)"
      />
      <path fill="none" stroke="var(--cable)" strokeWidth="5" strokeLinecap="round" />
      <path
        fill="none"
        stroke="rgb(255 255 255 / .28)"
        strokeWidth="1.4"
        strokeLinecap="round"
        transform="translate(-.8 -1.2)"
      />
      <circle r="5.5" fill="var(--hole)" stroke="var(--plug)" strokeWidth="1.6" />
      <circle r="5.5" fill="var(--hole)" stroke="var(--plug)" strokeWidth="1.6" />
    </svg>
  );
}
