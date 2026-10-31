// Usage: node --experimental-strip-types tools/contrast-report.ts
// Prints every text pair below WCAG AA for every shipped theme. Exit code 1 if any.
import { contrastReport } from '../../src/theme/validate.ts';
import { readShippedThemes } from './themes-fs.ts';

let bad = 0;
for (const { theme } of readShippedThemes()) {
  const fails = contrastReport(theme);
  console.log(`${theme.id}: ${fails.length === 0 ? 'AA ok' : `${fails.length} below AA`}`);
  for (const f of fails) {
    console.log(
      `  ${f.mode} ${f.pair.fg} on ${f.pair.bg}: ${f.ratio.toFixed(2)} < ${f.pair.min} (${f.pair.what})`,
    );
  }
  bad += fails.length;
}
process.exit(bad === 0 ? 0 : 1);
