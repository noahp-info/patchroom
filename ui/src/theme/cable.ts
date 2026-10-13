/** Geometry for the Patch Bay patch cable. Pure, so it can be tested without a DOM. */

export interface Point {
  x: number;
  y: number;
}

/** Cubic path from the active row's jack to the conversation jack, sagging like a hanging cable. */
export function cablePath(from: Point, to: Point): string {
  const c1 = { x: from.x + 30, y: from.y + 40 };
  const c2 = { x: to.x + 2, y: to.y + 170 };
  return `M${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}
