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
import { fillLegacyTokens } from '../../src/theme/legacy.ts';
import { CABLE_PRESETS, THEME_CABLE, presetVars } from '../../src/theme/presets.ts';
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

test('cable path starts and ends at the plugs and rides the channel', () => {
  const d = cablePath({ x: 250, y: 327 }, { x: 299, y: 67 }, 272);
  assert.match(d, /^M250 327 C /);
  assert.ok(d.endsWith('299 67'));
  // Between the two bends the cable is a straight vertical run in the channel.
  assert.match(d, / L 272 81 /);
  assert.match(d, /272 313 L /);
  // No point leaves the box spanned by the two plugs and the channel.
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  for (let i = 0; i < nums.length; i += 2) {
    assert.ok(nums[i] >= 250 && nums[i] <= 299, `x ${nums[i]}`);
    assert.ok(nums[i + 1] >= 67 && nums[i + 1] <= 327, `y ${nums[i + 1]}`);
  }
});

const SRC = join(import.meta.dirname, '..', '..', 'src');
// Absolute paths of every .css under src except the theme dir (scanned above), styles.css
// included, so any new stylesheet is covered automatically.
function p3Stylesheets(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return full === THEME_CSS ? [] : p3Stylesheets(full);
    return e.name.endsWith('.css') ? [full] : [];
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
    // Every stylesheet outside the theme dir, so new CSS cannot hard-code a color.
    ...p3Stylesheets(),
  ];
  const read = (f: string) =>
    readFileSync(f.startsWith('/') ? f : join(THEME_CSS, f), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
  // A stylesheet may derive its own variables from tokens (`--c-link: color-mix(...)`).
  const declared = new Set<string>(
    files.flatMap((f) => [...read(f).matchAll(/(?:^|[;{\s])--([a-z0-9-]+)\s*:/g)].map((m) => m[1])),
  );
  // Variables the UI sets inline from runtime data, with a CSS fallback where one is needed.
  const inlineVars = new Set(['pct', 'term-bg', 'termbar-bg', 'termbar-line', 'termbar-fg']);
  for (const f of files) {
    const css = read(f);
    for (const m of css.matchAll(/var\(--([a-z0-9-]+)/g)) {
      assert.ok(
        tokens.has(m[1]) || baseVars.has(m[1]) || declared.has(m[1]) || inlineVars.has(m[1]),
        `${f} uses undefined --${m[1]}`,
      );
    }
  }
});

test('token groups are all non-empty', () => {
  for (const [g, keys] of Object.entries(TOKEN_GROUPS)) assert.ok(keys.length > 0, g);
});

const MODES = ['light', 'dark'] as const;

test('Homeroom is jade: the mark color anchors the band, panel and workspace mark', () => {
  assert.equal(homeroom.modes.light['side-bg'], '#135a4b');
  assert.equal(homeroom.modes.light.panel, '#135a4b');
  assert.equal(homeroom.modes.light['ws-mark-fg'], '#135a4b');
  assert.equal(homeroom.modes.light['ws-mark'], '#f7f3e8');
  for (const mode of MODES) {
    const t = homeroom.modes[mode];
    assert.equal(t['side-active'].toLowerCase().startsWith('#f2c35b') || mode === 'dark', true);
    assert.equal(t.cable, '#f2c35b');
    assert.equal(t.plug, '#c7cdd0');
    // The accent reads as its own color, not as the band.
    assert.ok(contrast(t.accent, t['side-bg']) >= 1.3, `${mode} accent too close to the band`);
    assert.notEqual(t.accent, t['side-bg']);
  }
  assert.equal(validateTheme(homeroom, { requireAA: true }).ok, true);
});

test('the four shipped themes keep distinct sidebar grounds', () => {
  for (const mode of MODES) {
    const grounds = shipped.map((s) => s.theme.modes[mode]['side-bg']);
    assert.equal(new Set(grounds).size, shipped.length);
  }
});

test('cable and plug are hardware tokens in the schema and every shipped theme', () => {
  assert.ok((TOKEN_GROUPS.hardware as readonly string[]).includes('cable'));
  assert.ok((TOKEN_GROUPS.hardware as readonly string[]).includes('plug'));
  const props = buildSchema() as { $defs: { tokens: { required: string[] } } };
  assert.ok(props.$defs.tokens.required.includes('cable'));
  assert.ok(props.$defs.tokens.required.includes('plug'));
  for (const { theme } of shipped) {
    for (const mode of MODES) {
      assert.match(theme.modes[mode].cable, /^#[0-9a-f]{6}$/i);
      assert.match(theme.modes[mode].plug, /^#[0-9a-f]{6}$/i);
    }
  }
});

test('a P3-era theme without cable and plug loads, validates and keeps its own tokens', () => {
  const old = JSON.parse(JSON.stringify(homeroom));
  for (const mode of MODES) {
    delete old.modes[mode].cable;
    delete old.modes[mode].plug;
  }
  old.id = 'p3-custom';
  const r = validateTheme(old, { requireAA: true });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('; '));
  if (!r.ok) return;
  for (const mode of MODES) {
    assert.equal(r.theme.modes[mode].cable, old.modes[mode]['c-yellow']);
    assert.match(r.theme.modes[mode].plug, /^#[0-9a-f]{6}$/);
    assert.equal(r.theme.modes[mode].accent, old.modes[mode].accent);
  }
  // The caller's object is not mutated, and a complete theme passes through untouched.
  assert.equal(old.modes.light.cable, undefined);
  assert.equal(fillLegacyTokens(homeroom), homeroom);
  // A bad value is still reported, not papered over.
  old.modes.light['c-yellow'] = 'nope';
  assert.equal(validateTheme(old).ok, false);
});

test('Slack import derives cable and plug', () => {
  const r = importSlackTheme('#350d36,#3e313c,#1264a3,#ffffff', {
    base: homeroom,
    id: 'slack-x',
    name: 'X',
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  for (const mode of MODES) {
    // Derived from the active row, then lifted by the AA repair so it reads in the socket.
    assert.notEqual(r.theme.modes[mode].cable, homeroom.modes[mode].cable);
    assert.ok(contrast(r.theme.modes[mode].cable, r.theme.modes[mode].hole) >= 3);
    assert.notEqual(r.theme.modes[mode].plug, homeroom.modes[mode].plug);
  }
  assert.equal(validateTheme(r.theme, { requireAA: true }).ok, true);
});

test('at least four named presets, each overriding only cable and plug', () => {
  assert.ok(CABLE_PRESETS.length >= 4);
  assert.deepEqual(
    ['jade', 'signal', 'studio', 'ocean', 'copper'].filter(
      (id) => !CABLE_PRESETS.some((p) => p.id === id),
    ),
    [],
  );
  const pairs = new Set(CABLE_PRESETS.map((p) => `${p.modes.light.cable}/${p.modes.light.plug}`));
  assert.equal(pairs.size, CABLE_PRESETS.length);
  for (const { theme } of shipped) {
    for (const mode of MODES) {
      const base = themeVars(theme, mode);
      for (const p of CABLE_PRESETS) {
        const v = themeVars(theme, mode, p.id);
        const changed = Object.keys(v).filter((k) => v[k] !== base[k]);
        assert.ok(
          changed.every((k) => k === '--cable' || k === '--plug'),
          `${p.id} leaked ${changed}`,
        );
        assert.equal(v['--cable'], p.modes[mode].cable);
      }
    }
  }
  assert.deepEqual(presetVars(THEME_CABLE, 'light'), {});
  assert.deepEqual(presetVars(undefined, 'dark'), {});
  assert.deepEqual(presetVars('no-such-preset', 'dark'), {});
});

test('every preset reads against the socket hole in every shipped theme and mode (3:1)', () => {
  for (const { theme } of shipped) {
    for (const mode of MODES) {
      const hole = theme.modes[mode].hole;
      for (const p of CABLE_PRESETS) {
        const { cable, plug } = p.modes[mode];
        assert.ok(
          contrast(cable, hole) >= 3,
          `${theme.id} ${mode} ${p.id} cable ${contrast(cable, hole).toFixed(2)}`,
        );
        assert.ok(
          contrast(plug, hole) >= 3,
          `${theme.id} ${mode} ${p.id} plug ${contrast(plug, hole).toFixed(2)}`,
        );
      }
    }
  }
});

test('Patch Bay draws cables in --cable and plug metal in --plug, not in a chip color', () => {
  const css = readFileSync(join(THEME_CSS, 'bases', 'patchbay.css'), 'utf8');
  assert.match(css, /\.jack\.plugged::before\s*\{[^}]*var\(--cable\)/);
  assert.match(css, /var\(--plug\)/);
  const tsx = readFileSync(join(THEME_CSS, 'PatchCable.tsx'), 'utf8');
  assert.match(tsx, /stroke="var\(--cable\)"/);
  assert.match(tsx, /stroke="var\(--plug\)"/);
  assert.doesNotMatch(tsx, /c-yellow/);
});
