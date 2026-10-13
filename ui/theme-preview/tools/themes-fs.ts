import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseTheme } from '../../src/theme/validate.ts';
import type { Theme } from '../../src/theme/types.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const THEMES_DIR = join(REPO_ROOT, 'plugins', 'themes');

/** Read every shipped theme file from disk. Throws on the first invalid one. */
export function readShippedThemes(): { file: string; theme: Theme }[] {
  const out: { file: string; theme: Theme }[] = [];
  for (const plugin of readdirSync(THEMES_DIR, { withFileTypes: true })) {
    if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue;
    const dir = join(THEMES_DIR, plugin.name, 'themes');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const file = join(dir, f);
      const r = parseTheme(readFileSync(file, 'utf8'));
      if (!r.ok) throw new Error(`${file}: ${r.errors.join('; ')}`);
      out.push({ file, theme: r.theme });
    }
  }
  return out;
}
