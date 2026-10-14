// Run: node --experimental-strip-types --test tests/
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyTheme, themeToCss, themeVars } from '../../src/theme/apply.ts';
import { cablePath } from '../../src/theme/cable.ts';
import {
  contrast,
  ensureContrast,
  isColor,
  parseColor,
  readableOn,
} from '../../src/theme/color.ts';
import { importSlackTheme, parseSlackThemeString } from '../../src/theme/slack.ts';
import { TOKEN_GROUPS, TOKEN_KEYS } from '../../src/theme/tokens.ts';
import type { Theme, TokenMap } from '../../src/theme/types.ts';
import { contrastReport, parseTheme, validateTheme } from '../../src/theme/validate.ts';
import { buildSchema } from '../tools/gen-schema.ts';
import { THEMES_DIR, readShippedThemes } from '../tools/themes-fs.ts';

const shipped = readShippedThemes();
const homeroom = shipped.find((s) => s.theme.id === 'homeroom')!.theme;
const THEME_CSS = join(import.meta.dirname, '..', '..', 'src', 'theme');

test('token list has no duplicates and 80+ tokens', () => {
  assert.equal(new Set(TOKEN_KEYS).size, TOKEN_KEYS.length);
  assert.ok(TOKEN_KEYS.length > 80);
});

test('at least Homeroom, Patch Bay and one more theme ship as plugins', () => {
  const ids = shipped.map((s) => s.theme.id);
  assert.ok(ids.includes('homeroom'));
  assert.ok(ids.includes('patch-bay'));
  assert.ok(ids.length >= 3);
  assert.equal(new Set(ids).size, ids.length);
});

test('every shipped theme is complete and passes WCAG AA in light and dark', () => {
  for (const { file, theme } of shipped) {
    const r = validateTheme(theme, { requireAA: true });
    assert.ok(r.ok, `${file}: ${r.ok ? '' : r.errors.join('; ')}`);
    assert.deepEqual(contrastReport(theme), []);
  }
});

test('theme plugins are data only and registered in the marketplace', () => {
  const market = JSON.parse(
    readFileSync(join(THEMES_DIR, '.claude-plugin', 'marketplace.json'), 'utf8'),
  );
  const dirs = readdirSync(THEMES_DIR, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && !d.name.startsWith('.'),
  );
  assert.equal(market.plugins.length, dirs.length);
  for (const d of dirs) {
    const m = JSON.parse(
      readFileSync(join(THEMES_DIR, d.name, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    assert.equal(m.patchroom.kind, 'data');
    for (const banned of [
      'hooks',
      'mcpServers',
      'commands',
      'agents',
      'skills',
      'main',
      'scripts',
    ]) {
      assert.equal(m[banned], undefined, `${d.name} must not declare ${banned}`);
    }
    for (const t of m.patchroom.themes) assert.ok(existsSync(join(THEMES_DIR, d.name, t.file)));
    assert.ok(market.plugins.some((p: { source: string }) => p.source === `./${d.name}`));
  }
});

test('schema file matches the token list', () => {
  const onDisk = JSON.parse(readFileSync(join(THEME_CSS, 'theme.schema.json'), 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(buildSchema())));
  assert.equal(Object.keys(onDisk.$defs.tokens.properties).length, TOKEN_KEYS.length);
});

test('validator rejects missing, unknown and malformed tokens', () => {
  const clone = (): Theme => JSON.parse(JSON.stringify(homeroom));
  const missing = clone();
  delete (missing.modes.dark as Record<string, string>).bg;
  assert.match(
    String((validateTheme(missing) as { errors: string[] }).errors),
    /modes\.dark\.bg is missing/,
  );

  const unknown = clone();
  (unknown.modes.light as Record<string, string>)['not-a-token'] = '#000';
  assert.match(
    String((validateTheme(unknown) as { errors: string[] }).errors),
    /not a known token/,
  );

  const badColor = clone();
  badColor.modes.light.accent = 'rebeccapurple';
  assert.match(
    String((validateTheme(badColor) as { errors: string[] }).errors),
    /accent is not a color/,
  );

  const badId = clone();
  badId.id = 'Not Valid';
  assert.equal(validateTheme(badId).ok, false);

  assert.equal(parseTheme('{nope').ok, false);
  assert.equal(validateTheme(null).ok, false);
});

test('requireAA flags a low-contrast theme', () => {
  const t: Theme = JSON.parse(JSON.stringify(homeroom));
  t.modes.light.muted = t.modes.light.bg;
  const r = validateTheme(t, { requireAA: true });
  assert.equal(r.ok, false);
});

test('color math', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(readableOn('#ffffff'), '#000000');
  assert.ok(isColor('#abc') && isColor('#aabbcc80') && isColor('transparent'));
  assert.ok(!isColor('red') && !isColor('#abcde'));
  assert.deepEqual(parseColor('#f00'), { r: 255, g: 0, b: 0, a: 1 });
  assert.ok(contrast(ensureContrast('#999999', '#ffffff'), '#ffffff') >= 4.5);
});

test('Slack theme strings parse in common paste shapes', () => {
  const s = '#3F0E40,#350D36,#1164A3,#FFFFFF,#350D36,#FFFFFF,#2BAC76,#CD2553,#19171D,#FFFFFF';
  const a = parseSlackThemeString(s);
  assert.ok(a.ok && a.colors.columnBg === '#3f0e40' && a.colors.topNavText === '#ffffff');
  assert.ok(parseSlackThemeString(`"${s}"`).ok);
  assert.ok(parseSlackThemeString(`{"theme": "${s}"}`).ok);
  assert.ok(parseSlackThemeString('3F0E40, 350D36, 1164A3, FFFFFF').ok);
  assert.equal(parseSlackThemeString('#3F0E40,#350D36').ok, false);
  assert.equal(parseSlackThemeString('#3F0E40,#350D36,#1164A3,#GGGGGG').ok, false);
});

test('Slack import maps to tokens and yields a valid AA theme', () => {
  const s = '#3F0E40,#350D36,#1164A3,#FFFFFF,#350D36,#FFFFFF,#2BAC76,#CD2553,#19171D,#FFFFFF';
  const r = importSlackTheme(s, { base: homeroom, id: 'aubergine-slack', name: 'Aubergine' });
  assert.ok(r.ok);
  if (!r.ok) return;
  for (const mode of ['light', 'dark'] as const) {
    const t: TokenMap = r.theme.modes[mode];
    assert.equal(t['side-bg'], '#3f0e40');
    assert.equal(t['side-active'], '#1164a3');
    assert.equal(t['tb-bg'], '#19171d');
    assert.equal(t.busy, '#2bac76');
    assert.equal(t.panel, '#3f0e40');
  }
  const v = validateTheme(r.theme, { requireAA: true });
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  // Surfaces Slack does not carry stay as the base theme had them.
  assert.equal(r.theme.modes.light.bg, homeroom.modes.light.bg);
  assert.equal(r.theme.modes.dark.bg, homeroom.modes.dark.bg);
});

test('Slack import repairs a low-contrast sidebar text color', () => {
  const r = importSlackTheme('#f4ede4,#e8dfd2,#fadfa3,#3d3c40,#e8dfd2,#c9c4bc', {
    base: homeroom,
    id: 'pale-slack',
    name: 'Pale',
  });
  assert.ok(r.ok);
  if (r.ok)
    assert.ok(contrast(r.theme.modes.light['side-fg'], r.theme.modes.light['side-bg']) >= 4.5);
});

test('applyTheme writes every token as a CSS variable and nothing else changes', () => {
  const props = new Map<string, string>();
  const el = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: '', setProperty: (k: string, v: string) => props.set(k, v) },
  };
  applyTheme(el as unknown as HTMLElement, homeroom, 'dark', 'patchbay');
  assert.equal(props.size, TOKEN_KEYS.length);
  assert.equal(props.get('--bg'), homeroom.modes.dark.bg);
  assert.deepEqual(el.dataset, { base: 'patchbay', mode: 'dark', theme: 'homeroom' });
  assert.equal(el.style.colorScheme, 'dark');
  const pb = shipped.find((s) => s.theme.id === 'patch-bay')!.theme;
  assert.deepEqual(Object.keys(themeVars(pb, 'dark')), Object.keys(themeVars(homeroom, 'dark')));
  assert.match(themeToCss(homeroom), /\[data-theme='homeroom'\]\[data-mode='dark'\]/);
});

test('cable path starts and ends at the plugs', () => {
  const d = cablePath({ x: 10, y: 20 }, { x: 300, y: 40 });
  assert.match(d, /^M10 20 C /);
  assert.ok(d.endsWith('300 40'));
});

const SRC = join(import.meta.dirname, '..', '..', 'src');
// Absolute paths of every .css under src except the theme dir (scanned above) and the
// workspace-owned styles.css, so any new P3 stylesheet is covered automatically.
function p3Stylesheets(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return full === THEME_CSS ? [] : p3Stylesheets(full);
    return e.name.endsWith('.css') && full !== join(SRC, 'styles.css') ? [full] : [];
  });
}

// The separation guarantee: CSS never names a color. Only theme tokens carry color.
test('base CSS contains no color literals beyond the allowed constants', () => {
  const files = [
    'base.css',
    ...readdirSync(join(THEME_CSS, 'bases')).map((f) => `bases/${f}`),
    // Every P3 stylesheet outside the theme dir, so new CSS cannot hard-code a color.
    ...p3Stylesheets(),
  ];
  // macOS window controls and neutral black or white alpha for shadows and glints.
  const allowedHex = new Set(['#fff', '#ffffff', '#000', '#ec6a5e', '#f4bf4f', '#61c554']);
  for (const f of files) {
    const css = readFileSync(f.startsWith('/') ? f : join(THEME_CSS, f), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      assert.ok(allowedHex.has(m[0].toLowerCase()), `${f} hard-codes ${m[0]}`);
    }
    for (const m of css.matchAll(/rgb\(([^)]*)\)/g)) {
      assert.match(m[1], /^(0 0 0|255 255 255)\s*\//, `${f} uses non-neutral ${m[0]}`);
    }
    assert.ok(
      !/\b(red|blue|green|yellow|orange|purple|white|black|gray|grey)\b\s*[;}]/.test(css),
      `${f} names a color`,
    );
  }
});

test('every var(--x) in the CSS is a token or a documented base variable', () => {
  const baseVars = new Set([
    'side-w',
    'art-w',
    'r',
    'r-sm',
    'row-h',
    'gutter',
    'log-gap',
    'text',
    'f-ui',
    'f-mono',
    'f-label',
    'glyph',
    'f-prose',
    'app-w',
    'app-h',
    'app-radius',
    'led',
    'cc',
  ]);
  const tokens = new Set<string>(TOKEN_KEYS);
  const files = [
    'base.css',
    ...readdirSync(join(THEME_CSS, 'bases')).map((f) => `bases/${f}`),
    // Every P3 stylesheet outside the theme dir, so new CSS cannot hard-code a color.
    ...p3Stylesheets(),
  ];
  for (const f of files) {
    const css = readFileSync(f.startsWith('/') ? f : join(THEME_CSS, f), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    for (const m of css.matchAll(/var\(--([a-z0-9-]+)/g)) {
      assert.ok(tokens.has(m[1]) || baseVars.has(m[1]), `${f} uses undefined --${m[1]}`);
    }
  }
});

test('token groups are all non-empty', () => {
  for (const [g, keys] of Object.entries(TOKEN_GROUPS)) assert.ok(keys.length > 0, g);
});
