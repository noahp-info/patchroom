/** Geometry for the Patch Bay patch cable. Pure, so it can be tested without a DOM. */

export interface Point {
  x: number;
  y: number;
}

/** Corner radius of the two bends. */
const BEND = 14;

/**
 * Cable run from the active row's jack to the conversation jack. It never crosses content:
 * it leaves the row sideways, rides the vertical channel at `channelX` (the strip of padding
 * between the sidebar content and the conversation), then turns into the header jack. Both
 * bends are one cubic each, so the path is `M .. C .. L .. C .. L ..`.
 */
export function cablePath(from: Point, to: Point, channelX: number): string {
  const up = Math.min(BEND, Math.max(0, (from.y - to.y) / 2));
  const r = Math.min(BEND, Math.max(0, to.x - channelX));
  const a = { x: channelX, y: from.y - up };
  const b = { x: channelX, y: to.y + up };
  const c = { x: channelX + r, y: to.y };
  return (
    `M${from.x} ${from.y} C ${a.x} ${from.y}, ${a.x} ${from.y}, ${a.x} ${a.y} ` +
    `L ${b.x} ${b.y} C ${b.x} ${to.y}, ${b.x} ${to.y}, ${c.x} ${c.y} L ${to.x} ${to.y}`
  );
}
