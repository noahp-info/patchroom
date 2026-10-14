import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drain, openWithDm } from './helpers';

// Fidelity: replay a recorded real claude byte stream (tests/fixtures/claude-haiku.jsonl, captured
// by tests/tools/record-fixture through the patchroom-pty crate) through the xterm.js terminal and through pyte, then compare
// every cell: character, foreground, background and attributes. Two checkpoints: the stream at
// 120x40, and after the PTY was resized to 80x30 and claude redrew.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'claude-haiku.jsonl');
const COMMITTED_REF = join(here, 'fixtures', 'claude-haiku.pyte.json');
const VENV_PYTHON = join(here, '..', 'node_modules', '.pyte-venv', 'bin', 'python');

interface FixtureEvent {
  k: 'size' | 'out' | 'resize' | 'mark';
  cols?: number;
  rows?: number;
  d?: string;
  name?: string;
}

type Cell = [string, string, string, string];
interface Screen {
  cols: number;
  rows: number;
  cells: Cell[][];
}

/**
 * Where the reference screens come from. By default pyte runs live from the pinned venv made by
 * tests/tools/setup_pyte.sh (or from $PYTHON). A missing pyte fails the test loudly. Setting
 * PR_FIDELITY_COMMITTED_REF=1 opts into the dump committed beside the fixture instead.
 */
function referenceScreens(): Record<string, Screen> {
  if (process.env.PR_FIDELITY_COMMITTED_REF === '1') {
    return JSON.parse(readFileSync(COMMITTED_REF, 'utf8')) as Record<string, Screen>;
  }
  const python = process.env.PYTHON ?? VENV_PYTHON;
  if (!existsSync(python)) {
    throw new Error(
      `No pyte interpreter at ${python}. Run ui/tests/tools/setup_pyte.sh, set PYTHON to an ` +
        'interpreter with pyte, or set PR_FIDELITY_COMMITTED_REF=1 to use the committed reference.',
    );
  }
  try {
    const out = execFileSync(python, ['-I', join(here, 'tools', 'pyte_ref.py'), FIXTURE], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.toString()) as Record<string, Screen>;
  } catch (err) {
    const msg = String((err as { stderr?: Buffer }).stderr ?? err);
    throw new Error(`pyte reference failed (${python}).\n${msg}`, { cause: err });
  }
}

/** Dump the visible screen of the xterm.js buffer in the same normalised form as pyte_ref.py. */
async function xtermScreen(page: Page, id: string): Promise<Screen> {
  return page.evaluate((sid) => {
    type Buf = {
      baseY: number;
      getLine(y: number):
        | {
            getCell(x: number):
              | {
                  getChars(): string;
                  getWidth(): number;
                  isFgDefault(): boolean;
                  isFgPalette(): boolean;
                  isFgRGB(): boolean;
                  getFgColor(): number;
                  isBgDefault(): boolean;
                  isBgPalette(): boolean;
                  isBgRGB(): boolean;
                  getBgColor(): number;
                  isBold(): number;
                  isItalic(): number;
                  isUnderline(): number;
                  isInverse(): number;
                  isStrikethrough(): number;
                }
              | undefined;
          }
        | undefined;
    };
    const term = (
      window as unknown as {
        __PR_TERMS__: Record<
          string,
          { term: { cols: number; rows: number; buffer: { active: Buf } } }
        >;
      }
    ).__PR_TERMS__[sid].term;
    const levels = [0, 95, 135, 175, 215, 255];
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    const paletteHex = (i: number): string => {
      if (i >= 232) {
        const v = 8 + (i - 232) * 10;
        return hex(v) + hex(v) + hex(v);
      }
      const n = i - 16;
      return (
        hex(levels[Math.floor(n / 36)]) + hex(levels[Math.floor(n / 6) % 6]) + hex(levels[n % 6])
      );
    };
    const color = (def: boolean, pal: boolean, rgb: boolean, v: number): string => {
      if (def) return 'default';
      if (pal) return v < 16 ? `p${v}` : `x${paletteHex(v)}`;
      if (rgb) return `x${hex((v >> 16) & 255)}${hex((v >> 8) & 255)}${hex(v & 255)}`;
      return 'default';
    };
    const buf = term.buffer.active;
    const cells: [string, string, string, string][][] = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      const row: [string, string, string, string][] = [];
      for (let x = 0; x < term.cols; x++) {
        const c = line?.getCell(x);
        if (!c) {
          row.push([' ', 'default', 'default', '']);
          continue;
        }
        const flags =
          (c.isBold() ? 'b' : '') +
          (c.isItalic() ? 'i' : '') +
          (c.isUnderline() ? 'u' : '') +
          (c.isInverse() ? 'r' : '') +
          (c.isStrikethrough() ? 's' : '');
        const ch = c.getChars();
        row.push([
          c.getWidth() === 0 ? '' : ch === '' ? ' ' : ch,
          color(c.isFgDefault(), c.isFgPalette(), c.isFgRGB(), c.getFgColor()),
          color(c.isBgDefault(), c.isBgPalette(), c.isBgRGB(), c.getBgColor()),
          flags,
        ]);
      }
      cells.push(row);
    }
    return { cols: term.cols, rows: term.rows, cells };
  }, id);
}

/** pyte leaves unwritten cells as a space with default colors; so does xterm. Blank fg is moot. */
function canon(c: Cell): string {
  const [ch, fg, bg, flags] = c;
  const blank = ch === ' ' || ch === '';
  // Foreground and underline of an empty cell are invisible; background and inverse are not.
  const vis = blank ? flags.replace(/[bius]/g, '') : flags;
  const f = blank && !flags.includes('r') ? 'default' : fg;
  return `${ch}|${f}|${bg}|${vis}`;
}

function diff(label: string, a: Screen, b: Screen): string[] {
  const out: string[] = [];
  if (a.cols !== b.cols || a.rows !== b.rows) {
    out.push(`${label}: size xterm ${a.cols}x${a.rows} vs pyte ${b.cols}x${b.rows}`);
    return out;
  }
  for (let y = 0; y < a.rows; y++) {
    for (let x = 0; x < a.cols; x++) {
      const l = canon(a.cells[y][x]);
      const r = canon(b.cells[y][x]);
      if (l !== r) out.push(`${label} (${x},${y}): xterm ${l} vs pyte ${r}`);
    }
  }
  return out;
}

test('xterm.js matches pyte cell for cell at 120x40 and after resize to 80x30', async ({
  page,
}) => {
  const events = readFileSync(FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as FixtureEvent);
  const first = events[0];
  expect(first.k).toBe('size');
  const reference = referenceScreens();

  const id = await openWithDm(page, `mock&grid=${first.cols}x${first.rows}`);
  await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, '\x1bc'), id); // RIS: drop the mock banner
  await drain(page, id);

  const problems: string[] = [];
  let checked = 0;
  for (const e of events) {
    if (e.k === 'out') {
      await page.evaluate(([sid, d]) => window.__PR_MOCK__!.emitOutput(sid, d), [id, e.d!]);
    } else if (e.k === 'resize') {
      await drain(page, id);
      await page.evaluate(
        ([sid, c, r]) =>
          (
            window as unknown as {
              __PR_TERMS__: Record<string, { resize(c: number, r: number): void }>;
            }
          ).__PR_TERMS__[sid as string].resize(c as number, r as number),
        [id, e.cols!, e.rows!],
      );
    } else if (e.k === 'mark') {
      await drain(page, id);
      const got = await xtermScreen(page, id);
      const want = reference[e.name!];
      expect(want, `reference has mark ${e.name}`).toBeTruthy();
      problems.push(...diff(e.name!, got, want));
      checked += got.cols * got.rows;
      const flat = got.cells.flat();
      expect(flat.filter((c) => c[0].trim() !== '').length, 'screen is not blank').toBeGreaterThan(
        100,
      );
      expect(
        flat.some((c) => c[1].startsWith('x')),
        'truecolor cells present',
      ).toBe(true);
      expect(
        flat.some((c) => c[0] === '\u2705'),
        'wide emoji present',
      ).toBe(true);
    }
  }
  expect(checked).toBe(120 * 40 + 80 * 30);
  expect(problems.slice(0, 40), `${problems.length} differing cells`).toEqual([]);

  // The resize reached the backend as session_resize.
  const sizes = await page.evaluate(() =>
    window.__PR_MOCK__!.resizes.map((r) => `${r.cols}x${r.rows}`),
  );
  expect(sizes).toContain('120x40');
  expect(sizes.at(-1)).toBe('80x30');
});
