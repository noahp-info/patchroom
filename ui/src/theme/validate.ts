import { contrast, isColor } from './color.ts';
import { CONTRAST_PAIRS, TOKEN_KEYS } from './tokens.ts';
import type { ContrastPair } from './tokens.ts';
import type { Theme, ThemeMode, TokenMap } from './types.ts';

export const SCHEMA_VERSION = 1;
export const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODES: readonly ThemeMode[] = ['light', 'dark'];
const TOP_KEYS = new Set([
  '$schema',
  'schemaVersion',
  'id',
  'name',
  'description',
  'author',
  'license',
  'modes',
]);

export interface ContrastFailure {
  mode: ThemeMode;
  pair: ContrastPair;
  ratio: number;
}

export type ValidationResult = { ok: true; theme: Theme } | { ok: false; errors: string[] };

export interface ValidateOptions {
  /** Also fail when any text pair in `CONTRAST_PAIRS` misses WCAG AA. */
  requireAA?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Check shape, token completeness and color syntax of untrusted theme data. */
export function validateTheme(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['theme must be a JSON object'] };

  for (const k of Object.keys(input)) {
    if (!TOP_KEYS.has(k)) errors.push(`unknown top-level key "${k}"`);
  }
  if (input.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (typeof input.id !== 'string' || !THEME_ID.test(input.id)) {
    errors.push('id must be lowercase words joined by hyphens, e.g. "patch-bay"');
  }
  if (typeof input.name !== 'string' || input.name.trim() === '' || input.name.length > 60) {
    errors.push('name must be a non-empty string of at most 60 characters');
  }
  for (const k of ['description', 'author', 'license'] as const) {
    if (input[k] !== undefined && typeof input[k] !== 'string')
      errors.push(`${k} must be a string`);
  }

  const modes = input.modes;
  if (!isRecord(modes)) {
    errors.push('modes must be an object with "light" and "dark"');
  } else {
    for (const k of Object.keys(modes)) {
      if (!MODES.includes(k as ThemeMode)) errors.push(`unknown mode "${k}"`);
    }
    for (const mode of MODES) {
      const map = modes[mode];
      if (!isRecord(map)) {
        errors.push(`modes.${mode} is missing`);
        continue;
      }
      for (const key of TOKEN_KEYS) {
        const v = map[key];
        if (v === undefined) errors.push(`modes.${mode}.${key} is missing`);
        else if (typeof v !== 'string' || !isColor(v)) {
          errors.push(
            `modes.${mode}.${key} is not a color (use #rgb, #rrggbb, #rrggbbaa): ${String(v)}`,
          );
        }
      }
      for (const key of Object.keys(map)) {
        if (!(TOKEN_KEYS as readonly string[]).includes(key)) {
          errors.push(`modes.${mode}.${key} is not a known token`);
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const theme = input as unknown as Theme;
  if (opts.requireAA) {
    const fails = contrastReport(theme);
    for (const f of fails) {
      errors.push(
        `${f.mode}: ${f.pair.fg} on ${f.pair.bg} is ${f.ratio.toFixed(2)}:1, needs ${f.pair.min}:1 (${f.pair.what})`,
      );
    }
    if (errors.length > 0) return { ok: false, errors };
  }
  return { ok: true, theme };
}

/** Parse theme JSON text, then validate it. */
export function parseTheme(text: string, opts: ValidateOptions = {}): ValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] };
  }
  return validateTheme(data, opts);
}

/** Score every text pair in both modes. Returns only the failures. The theme must be valid. */
export function contrastReport(theme: Theme): ContrastFailure[] {
  const out: ContrastFailure[] = [];
  for (const mode of MODES) {
    const t: TokenMap = theme.modes[mode];
    for (const pair of CONTRAST_PAIRS) {
      // Translucent fills are scored over the surface they sit on.
      const ratio = contrast(t[pair.fg], t[pair.bg], t[pair.ground ?? 'bg']);
      if (ratio < pair.min) out.push({ mode, pair, ratio });
    }
  }
  return out;
}
