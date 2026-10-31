import type { ChatItem } from '../ipc';

/**
 * Composer history, like Claude Code's prompt: Up brings back the messages sent in this session,
 * newest first, and Down walks forward to the draft that was there before.
 *
 * The source is the session's own main-log user messages (Claude Code keeps slash commands in
 * its history too, so they count), plus messages sent from Patchroom whose transcript entry has
 * not landed yet. Repeats in a row collapse to one, as a shell does.
 */

/** Whitespace-insensitive text, to match a sent message to its transcript entry. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Oldest first. `sent` is what this window sent, oldest first. */
export function historyEntries(items: readonly ChatItem[], sent: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== 'user' || it.parentToolUseId) continue;
    const t = it.text;
    if (t.trim() === '') continue;
    out.push(t);
    const k = norm(t);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  // A sent message counts once its entry is in the log; the ones still missing go last.
  for (const t of sent) {
    const k = norm(t);
    if (k === '') continue;
    const n = seen.get(k) ?? 0;
    if (n > 0) seen.set(k, n - 1);
    else out.push(t);
  }
  return out.filter((t, i) => i === 0 || norm(t) !== norm(out[i - 1]));
}

/** Where cycling stands: `index` 0 is the newest entry; `draft` comes back past the newest. */
export interface Cycle {
  index: number;
  draft: string;
  /** The text the box shows. Any edit ends the cycle. */
  shown: string;
}

export type Step =
  | { kind: 'show'; cycle: Cycle; text: string }
  | { kind: 'restore'; text: string }
  /** Nothing further back: the key is used up, the text stays. */
  | { kind: 'stay' }
  /** Not ours: the caret moves as usual. */
  | { kind: 'pass' };

/** Up: one entry further back. `entries` are oldest first. */
export function stepUp(entries: readonly string[], cycle: Cycle | null, text: string): Step {
  if (entries.length === 0) return { kind: 'pass' };
  const newest = entries.length - 1;
  if (!cycle) {
    const t = entries[newest];
    return { kind: 'show', cycle: { index: 0, draft: text, shown: t }, text: t };
  }
  const next = cycle.index + 1;
  if (next > newest) return { kind: 'stay' };
  const t = entries[newest - next];
  return { kind: 'show', cycle: { ...cycle, index: next, shown: t }, text: t };
}

/** Down: one entry forward, then the draft. Outside a cycle it is not ours. */
export function stepDown(entries: readonly string[], cycle: Cycle | null): Step {
  if (!cycle) return { kind: 'pass' };
  const next = cycle.index - 1;
  if (next < 0) return { kind: 'restore', text: cycle.draft };
  const t = entries[entries.length - 1 - next];
  if (t === undefined) return { kind: 'restore', text: cycle.draft };
  return { kind: 'show', cycle: { ...cycle, index: next, shown: t }, text: t };
}

/**
 * Is the caret on the first (or last) visual line of the box? Measured with the hidden twin,
 * which has the box's width and font: the text up to the caret is one line tall exactly when the
 * caret is on the first line, and as tall as the whole text when it is on the last. A wrapped
 * line counts as several, so Up inside a long paragraph still moves the caret.
 */
export function caretRows(
  twin: HTMLTextAreaElement | null,
  value: string,
  start: number,
  end: number,
): { first: boolean; last: boolean } {
  const logicalFirst = !value.slice(0, start).includes('\n');
  const logicalLast = !value.slice(end).includes('\n');
  if (!twin) return { first: logicalFirst, last: logicalLast };
  const keep = twin.value;
  const height = (s: string) => {
    twin.value = s;
    return twin.scrollHeight;
  };
  try {
    const one = height('');
    const before = height(value.slice(0, start));
    const through = height(value.slice(0, end));
    const all = height(value);
    return {
      first: logicalFirst && before <= one,
      last: logicalLast && through >= all,
    };
  } finally {
    twin.value = keep;
  }
}
