import type { DraftComment } from './comments';

/** The CSS Custom Highlight names styled in styles.css. */
const ALL = 'pr-comment';
const ACTIVE = 'pr-comment-active';

const supported = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS;

/** A range over `len` characters of `row`'s text starting at `at`, across element boundaries. */
function rangeAt(row: Element, at: number, len: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let start: [Node, number] | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const size = n.textContent?.length ?? 0;
    if (!start && at < seen + size) start = [n, at - seen];
    if (start && at + len <= seen + size) {
      const r = document.createRange();
      r.setStart(start[0], start[1]);
      r.setEnd(n, at + len - seen);
      return r;
    }
    seen += size;
  }
  return null;
}

/** The first place `quote` appears in `row`, when the stored offset no longer matches. */
function rangeOf(row: Element, quote: string): Range | null {
  const text = row.textContent ?? '';
  const first = quote.split('\n')[0].replace(/…$/, '').trim();
  if (!first) return null;
  const at = text.indexOf(first);
  return at < 0 ? null : rangeAt(row, at, first.length);
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The range a comment quotes inside `root`, or null when its row is not rendered. */
export function commentRange(root: ParentNode, c: DraftComment): Range | null {
  if (!c.key) return null;
  const row = root.querySelector(`[data-key="${CSS.escape(c.key)}"]`);
  if (!row) return null;
  if (c.at !== undefined && c.len) {
    const r = rangeAt(row, c.at, c.len);
    const want = norm(c.quote.replace(/…$/, ''));
    if (r && norm(r.toString()).startsWith(want.slice(0, 40))) return r;
  }
  return rangeOf(row, c.quote);
}

/**
 * Mark every quoted passage in `root`, the active one stronger. Returns the active range so
 * the caller can keep it in view. A no-op where the Highlight API is missing.
 */
export function paintComments(
  root: ParentNode,
  comments: DraftComment[],
  activeId: string | null,
): Range | null {
  if (!supported()) return null;
  const all: Range[] = [];
  let active: Range | null = null;
  for (const c of comments) {
    const r = commentRange(root, c);
    if (!r) continue;
    if (c.id === activeId) active = r;
    else all.push(r);
  }
  CSS.highlights.set(ALL, new Highlight(...all));
  if (active) CSS.highlights.set(ACTIVE, new Highlight(active));
  else CSS.highlights.delete(ACTIVE);
  return active;
}

export function clearComments(): void {
  if (!supported()) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(ACTIVE);
}
