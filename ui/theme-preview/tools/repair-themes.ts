// Usage: node --experimental-strip-types tools/repair-themes.ts [--write]
// Nudges failing text colors in every shipped theme to WCAG AA and prints each change.
// Without --write it only reports. Surfaces are never touched.
import { readFileSync, writeFileSync } from 'node:fs';
import { repairContrast } from '../../src/theme/repair.ts';
import { TOKEN_KEYS } from '../../src/theme/tokens.ts';
import type { Theme } from '../../src/theme/types.ts';
import { readShippedThemes } from './themes-fs.ts';

const write = process.argv.includes('--write');
for (const { file, theme } of readShippedThemes()) {
  const fixed = repairContrast(theme);
  let changed = 0;
  for (const mode of ['light', 'dark'] as const) {
    for (const k of TOKEN_KEYS) {
      if (theme.modes[mode][k] !== fixed.modes[mode][k]) {
        changed++;
        console.log(`${theme.id} ${mode} ${k}: ${theme.modes[mode][k]} -> ${fixed.modes[mode][k]}`);
      }
    }
  }
  if (write && changed > 0) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Theme;
    raw.modes = fixed.modes;
    writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  }
}
