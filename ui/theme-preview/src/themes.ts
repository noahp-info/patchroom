import { validateTheme } from '../../src/theme/index.ts';
import type { Theme } from '../../src/theme/index.ts';

// Every first-party theme plugin ships one JSON file per theme. Load them all and validate.
const files = import.meta.glob('../../../plugins/themes/*/themes/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

export interface LoadedThemes {
  themes: Theme[];
  problems: { file: string; errors: string[] }[];
}

export function loadShippedThemes(): LoadedThemes {
  const themes: Theme[] = [];
  const problems: LoadedThemes['problems'] = [];
  for (const [file, data] of Object.entries(files)) {
    const r = validateTheme(data);
    if (r.ok) themes.push(r.theme);
    else problems.push({ file, errors: r.errors });
  }
  const order = ['homeroom', 'patch-bay'];
  themes.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  });
  return { themes, problems };
}
