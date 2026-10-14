import type { ToolItem } from '../ipc';

export type DiffRowType = 'hunk' | 'ctx' | 'add' | 'del';
export interface DiffRow {
  type: DiffRowType;
  oldN?: number;
  newN?: number;
  text: string;
}
export interface DiffView {
  path?: string;
  rows: DiffRow[];
  added: number;
  removed: number;
}

const MAX_ROWS = 600;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Parse a unified diff. Lines before the first hunk header (---/+++ and so on) are skipped. */
export function parseUnified(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      inHunk = true;
      rows.push({ type: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) rows.push({ type: 'add', newN: n++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ type: 'del', oldN: o++, text: line.slice(1) });
    else if (line.startsWith('\\')) continue;
    else
      rows.push({
        type: 'ctx',
        oldN: o++,
        newN: n++,
        text: line.startsWith(' ') ? line.slice(1) : line,
      });
  }
  // A trailing empty context row comes from the final newline.
  if (rows.length && rows[rows.length - 1].type === 'ctx' && rows[rows.length - 1].text === '')
    rows.pop();
  return rows;
}

/** Line diff of two strings. LCS up to a size cap, otherwise a plain replace. */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const mid: { type: DiffRowType; text: string }[] = [];
  if (am.length * bm.length > 1_500_000) {
    for (const t of am) mid.push({ type: 'del', text: t });
    for (const t of bm) mid.push({ type: 'add', text: t });
  } else {
    const w = bm.length + 1;
    const dp = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        dp[i * w + j] =
          am[i] === bm[j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        mid.push({ type: 'ctx', text: am[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) mid.push({ type: 'del', text: am[i++] });
      else mid.push({ type: 'add', text: bm[j++] });
    }
    while (i < am.length) mid.push({ type: 'del', text: am[i++] });
    while (j < bm.length) mid.push({ type: 'add', text: bm[j++] });
  }
  const rows: DiffRow[] = [];
  let o = 1;
  let n = 1;
  const push = (type: DiffRowType, text: string) => {
    if (type === 'ctx') rows.push({ type, oldN: o++, newN: n++, text });
    else if (type === 'del') rows.push({ type, oldN: o++, text });
    else rows.push({ type, newN: n++, text });
  };
  o = 1 + Math.max(0, pre - 2);
  n = o;
  for (const t of a.slice(Math.max(0, pre - 2), pre)) push('ctx', t);
  for (const m of mid) push(m.type, m.text);
  for (const t of a.slice(a.length - suf, a.length - suf + 2)) push('ctx', t);
  return rows;
}

function summarize(rows: DiffRow[], path?: string): DiffView {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'del') removed++;
  }
  return { path, rows: rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows, added, removed };
}

function fromHunks(hunks: unknown[]): DiffRow[] | null {
  const rows: DiffRow[] = [];
  for (const h of hunks) {
    if (!isObj(h)) return null;
    const lines = Array.isArray(h.lines)
      ? h.lines.filter((l): l is string => typeof l === 'string')
      : null;
    if (!lines) return null;
    const oldStart = typeof h.oldStart === 'number' ? h.oldStart : 1;
    const newStart = typeof h.newStart === 'number' ? h.newStart : 1;
    const oldLines = typeof h.oldLines === 'number' ? h.oldLines : '';
    const newLines = typeof h.newLines === 'number' ? h.newLines : '';
    rows.push({
      type: 'hunk',
      text:
        str(h.header) ??
        `@@ -${oldStart}${oldLines === '' ? '' : `,${oldLines}`} +${newStart}${newLines === '' ? '' : `,${newLines}`} @@`,
    });
    let o = oldStart;
    let n = newStart;
    for (const l of lines) {
      if (l.startsWith('+')) rows.push({ type: 'add', newN: n++, text: l.slice(1) });
      else if (l.startsWith('-')) rows.push({ type: 'del', oldN: o++, text: l.slice(1) });
      else
        rows.push({ type: 'ctx', oldN: o++, newN: n++, text: l.startsWith(' ') ? l.slice(1) : l });
    }
  }
  return rows;
}

function fromEdits(input: Record<string, unknown>): DiffRow[] | null {
  const edits: { o: string; n: string }[] = [];
  const o = str(input.old_string) ?? str(input.oldString);
  const n = str(input.new_string) ?? str(input.newString);
  if (o !== undefined && n !== undefined) edits.push({ o, n });
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (!isObj(e)) continue;
      const eo = str(e.old_string) ?? str(e.oldString);
      const en = str(e.new_string) ?? str(e.newString);
      if (eo !== undefined && en !== undefined) edits.push({ o: eo, n: en });
    }
  }
  if (!edits.length) return null;
  const rows: DiffRow[] = [];
  edits.forEach((e, i) => {
    const d = diffLines(e.o, e.n);
    rows.push({
      type: 'hunk',
      text: edits.length > 1 ? `@@ edit ${i + 1} of ${edits.length} @@` : '@@ edit @@',
    });
    rows.push(...d);
  });
  return rows;
}

/**
 * The diff to show for an Edit, MultiEdit or Write call, or null when the tool has none.
 * Reads `item.diff` first (any of several shapes), then the tool input.
 */
export function diffOf(item: ToolItem): DiffView | null {
  const input = isObj(item.input) ? item.input : {};
  const path = str(input.file_path) ?? str(input.filePath) ?? str(input.path);
  const d = item.diff;
  if (typeof d === 'string' && d.trim()) {
    const rows = parseUnified(d);
    if (rows.length) return summarize(rows, path);
  }
  if (isObj(d)) {
    const p = str(d.filePath) ?? str(d.path) ?? path;
    const u = str(d.unified) ?? str(d.patch) ?? str(d.diff);
    if (u) {
      const rows = parseUnified(u);
      if (rows.length) return summarize(rows, p);
    }
    if (Array.isArray(d.hunks) && d.hunks.length) {
      const rows = fromHunks(d.hunks);
      if (rows?.length) return summarize(rows, p);
    }
    if (Array.isArray(d.structuredPatch) && d.structuredPatch.length) {
      const rows = fromHunks(d.structuredPatch);
      if (rows?.length) return summarize(rows, p);
    }
    const o = str(d.oldString) ?? str(d.old_string) ?? str(d.old);
    const n = str(d.newString) ?? str(d.new_string) ?? str(d.new);
    if (o !== undefined && n !== undefined)
      return summarize([{ type: 'hunk', text: '@@ edit @@' }, ...diffLines(o, n)], p);
  }
  if (item.name === 'Edit' || item.name === 'MultiEdit') {
    const rows = fromEdits(input);
    if (rows) return summarize(rows, path);
  }
  if (item.name === 'Write') {
    const content = str(input.content);
    if (content !== undefined) {
      const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
      const rows: DiffRow[] = [{ type: 'hunk', text: `@@ new file, ${lines.length} lines @@` }];
      lines.forEach((t, i) => rows.push({ type: 'add', newN: i + 1, text: t }));
      return summarize(rows, path);
    }
  }
  return null;
}
