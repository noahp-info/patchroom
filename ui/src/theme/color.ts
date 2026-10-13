/** Small color toolkit: parse CSS hex colors, composite alpha, and score WCAG contrast. */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** True for `transparent` and for #rgb, #rgba, #rrggbb and #rrggbbaa. */
export function isColor(value: string): boolean {
  return value === 'transparent' || HEX.test(value);
}

export function parseColor(value: string): Rgba {
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (!HEX.test(value)) throw new Error(`Not a supported color: ${value}`);
  let h = value.slice(1);
  if (h.length <= 4) {
    h = [...h].map((c) => c + c).join('');
  }
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

export function toHex({ r, g, b }: Rgba): string {
  const x = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${x(r)}${x(g)}${x(b)}`;
}

/** Composite `top` over an opaque `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
    a: 1,
  };
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio. A translucent `fg` or `bg` is composited over `ground` (default white). */
export function contrast(fg: string, bg: string, ground = '#ffffff'): number {
  const g = parseColor(ground);
  const b = over(parseColor(bg), g);
  const f = over(parseColor(fg), b);
  const l1 = luminance(f);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Linear mix in sRGB: `t` of `b` into `a`. */
export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
    a: 1,
  });
}

/** Black or white, whichever reads better on `bg`. */
export function readableOn(bg: string): string {
  return contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
}

/**
 * Nudge `fg` toward black or white (whichever direction helps) until it reaches `min` on `bg`.
 * Returns `fg` unchanged when it already passes.
 */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
  for (let t = 0.04; t <= 1.0001; t += 0.04) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}
