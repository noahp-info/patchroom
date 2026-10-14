import { mix } from './color.ts';

/**
 * Tokens added after schema version 1 shipped, with how to derive each from tokens every older
 * theme already has. A stored custom theme or an imported one that lacks them is filled on load,
 * never rejected.
 */
const DERIVED: Record<string, (m: Record<string, unknown>) => string | undefined> = {
  cable: (m) => (typeof m['c-yellow'] === 'string' ? m['c-yellow'] : undefined),
  plug: (m) => (typeof m.nut === 'string' ? safeMix(m.nut, '#ffffff', 0.5) : undefined),
};

function safeMix(a: string, b: string, t: number): string | undefined {
  try {
    return mix(a, b, t);
  } catch {
    return undefined;
  }
}

/**
 * Return `input` with any missing post-P3 hardware token derived. Returns the same object when
 * nothing is missing, and never touches a token that is present (even a bad one, so validation
 * still reports it).
 */
export function fillLegacyTokens(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const rec = input as Record<string, unknown>;
  const modes = rec.modes;
  if (typeof modes !== 'object' || modes === null || Array.isArray(modes)) return input;
  let changed = false;
  const outModes: Record<string, unknown> = { ...(modes as Record<string, unknown>) };
  for (const [mode, map] of Object.entries(outModes)) {
    if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
    const m = map as Record<string, unknown>;
    let filled: Record<string, unknown> | null = null;
    for (const [key, derive] of Object.entries(DERIVED)) {
      if (m[key] !== undefined) continue;
      const v = derive(m);
      if (v === undefined) continue;
      filled ??= { ...m };
      filled[key] = v;
    }
    if (filled) {
      outModes[mode] = filled;
      changed = true;
    }
  }
  return changed ? { ...rec, modes: outModes } : input;
}
