import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWithDm, seedChat, sweepLog, watchErrors } from './helpers';

// Corpus render test. Every transcript from the local corpus, dumped by
// ui/tests/tools/dump-corpus.sh into a gitignored cache, renders in the chat view through the mock
// IPC with no console errors, one row per item. For five sampled transcripts every assistant text
// block also appears in the DOM. The cache is local only: with no dumps (CI) this file skips.

const here = dirname(fileURLToPath(import.meta.url));
const DIR =
  process.env.PR_CORPUS_DIR ?? join(here, '..', 'node_modules', '.cache', 'patchroom-corpus');
const files = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
  : [];

interface Item {
  key: string;
  kind: string;
  text?: string;
  parentToolUseId?: string;
}

/** Letters and digits only, lowercase: markdown syntax and spacing drop out on both sides. */
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The visible words of one markdown source line, without its syntax. */
function visibleLine(line: string): string {
  if (/^\s*(`{3,}|~{3,})/.test(line)) return ''; // fence lines
  if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return ''; // table rules and blank lines
  return line
    .replace(/^\s*(?:(?:#{1,6}|>|[-*+]|\d{1,9}[.)])\s+)+(?:\[[ xX]\]\s+)?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
}

const SAMPLED = new Set(
  [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (files.length - 1))).filter((i) => i >= 0),
);

test.describe('corpus', () => {
  test.skip(files.length === 0, `no corpus dumps in ${DIR}; run ui/tests/tools/dump-corpus.sh`);

  test('the corpus has the kinds of items the bar names', () => {
    const kinds = new Set<string>();
    for (const f of files) {
      const dump = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { items: Item[] };
      for (const i of dump.items) kinds.add(i.kind);
    }
    for (const k of ['user', 'assistant', 'tool', 'thinking']) expect(kinds).toContain(k);
  });

  files.forEach((file, index) => {
    const sampled = SAMPLED.has(index);
    test(`transcript ${String(index + 1).padStart(2, '0')} of ${files.length} renders${
      sampled ? ' with every assistant block' : ''
    }`, async ({ page }) => {
      test.setTimeout(240_000);
      const errs = watchErrors(page);
      const dump = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { items: Item[] };
      const main = dump.items.filter((i) => !i.parentToolUseId);
      const id = await openWithDm(page, 'mock', 'chat');
      await seedChat(page, id, dump.items);

      if (main.length === 0) {
        await expect(page.getByTestId('chat-empty')).toBeVisible();
        expect(errs).toEqual([]);
        return;
      }

      // The log opens on the newest page, then older pages load as the sweep scrolls up through
      // them. Sweep until every item has been seen.
      const seenKeys = new Set<string>();
      const text: Record<string, string> = {};
      let settled = 0;
      for (let pass = 0; pass < 40 && seenKeys.size < main.length; pass++) {
        const swept = await sweepLog(page);
        for (const k of swept.keys) seenKeys.add(k);
        Object.assign(text, swept.text);
        expect(swept.maxRendered).toBeLessThan(120);
        // Once every page is loaded, a few more full passes must see everything.
        const more = (await page.locator('.older').count()) > 0;
        if (!more && ++settled >= 3) break;
      }

      const missing = main
        .map((item, at) => ({ at, kind: item.kind, seen: seenKeys.has(item.key) }))
        .filter((m) => !m.seen)
        .map((m) => `${m.kind}@${m.at}/${main.length}`);
      expect(missing, 'items with no row (kind@position/total)').toEqual([]);

      if (sampled) {
        const lost: string[] = [];
        for (const item of main) {
          if (item.kind !== 'assistant' || !item.text) continue;
          const dom = squash(text[item.key] ?? '');
          for (const line of item.text.split('\n')) {
            const want = squash(visibleLine(line));
            if (want && !dom.includes(want)) lost.push(`${item.key}: ${want.slice(0, 60)}`);
          }
        }
        expect(lost, 'assistant text missing from the DOM').toEqual([]);
      }
      expect(errs).toEqual([]);
    });
  });
});
