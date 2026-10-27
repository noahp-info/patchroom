import type { ChatItem } from '../ipc';
import type { PromptState, QueuedMessage } from '../state/chat';
import { dayKey, formatDay, toMillis } from './time';

export type Author = 'user' | 'claude' | 'none';

export type Row =
  | { key: string; type: 'day'; label: string }
  | {
      key: string;
      type: 'item';
      item: ChatItem;
      head: boolean;
      author: Author;
      ms: number;
      /** Pending or resolved prompt that this question, plan or tool row answers. */
      prompt?: PromptState;
    }
  | { key: string; type: 'prompt'; prompt: PromptState; head: boolean; ms: number }
  /** A message Claude has queued and not read yet: always last, below the live turn. */
  | { key: string; type: 'queued'; queued: QueuedMessage; head: boolean };

/** Queued messages as rows, in send order, for the end of the log. */
export function queuedRows(queued: readonly QueuedMessage[]): Row[] {
  // One "You" header for the run, like consecutive sent messages.
  return queued.map((q, i) => ({
    key: `queued:${q.id}`,
    type: 'queued',
    queued: q,
    head: i === 0,
  }));
}

export function authorOf(item: ChatItem): Author {
  switch (item.kind) {
    case 'user':
      return 'user';
    case 'system':
    case 'fallback':
      return 'none';
    default:
      return 'claude';
  }
}

const GAP_MS = 5 * 60_000;

/**
 * Turn items and prompts into display rows: day dividers, author runs (a header on the first row
 * of a run), and prompts placed next to the tool call they belong to.
 */
export function buildRows(items: ChatItem[], prompts: PromptState[]): Row[] {
  // A question or plan prompt renders inside its own item row when that row exists.
  const byToolUse = new Map<string, number>();
  items.forEach((it, i) => {
    if ('toolUseId' in it && it.toolUseId) byToolUse.set(it.toolUseId, i);
  });
  const inline = new Map<number, PromptState>();
  const loose: PromptState[] = [];
  const after = new Map<number, PromptState[]>();
  for (const p of prompts) {
    const idx = p.toolUseId ? byToolUse.get(p.toolUseId) : undefined;
    if (idx !== undefined && (p.kind === 'question' || p.kind === 'plan')) {
      const it = items[idx];
      if (it.kind === 'question' || it.kind === 'plan') {
        inline.set(idx, p);
        continue;
      }
    }
    if (idx !== undefined) {
      const list = after.get(idx) ?? [];
      list.push(p);
      after.set(idx, list);
    } else loose.push(p);
  }
  // Loose prompts go before the first item that is newer than they are, else at the end.
  const before = new Map<number, PromptState[]>();
  const tail: PromptState[] = [];
  for (const p of loose) {
    let at = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (toMillis(items[i].ts) > p.at) at = i;
      else break;
    }
    if (at < 0) tail.push(p);
    else {
      const list = before.get(at) ?? [];
      list.push(p);
      before.set(at, list);
    }
  }

  const rows: Row[] = [];
  let prevAuthor: Author | 'break' = 'break';
  let prevMs = 0;
  let prevDay = '';
  const push = (author: Author, ms: number, key: string, make: (head: boolean) => Row) => {
    const d = ms ? dayKey(ms) : prevDay;
    // Out-of-order timestamps never open a new day: dividers only move forward.
    if (ms && d !== prevDay && ms >= prevMs) {
      // Keyed by the row it precedes: timestamps can go back to an earlier day.
      rows.push({ key: `day:${key}`, type: 'day', label: formatDay(ms) });
      prevDay = d;
      prevAuthor = 'break';
    }
    const head =
      author !== 'none' &&
      (prevAuthor !== author || (ms > 0 && prevMs > 0 && ms - prevMs > GAP_MS));
    rows.push(make(head));
    prevAuthor = author === 'none' ? 'break' : author;
    if (ms) prevMs = ms;
  };
  const pushPrompt = (p: PromptState) =>
    push('claude', p.at, `prompt:${p.promptId}`, (head) => ({
      key: `prompt:${p.promptId}`,
      type: 'prompt',
      prompt: p,
      head,
      ms: p.at,
    }));

  items.forEach((it, i) => {
    for (const p of before.get(i) ?? []) pushPrompt(p);
    const ms = toMillis(it.ts);
    const author = authorOf(it);
    push(author, ms, it.key, (head) => ({
      key: it.key,
      type: 'item',
      item: it,
      head,
      author,
      ms,
      prompt: inline.get(i),
    }));
    for (const p of after.get(i) ?? []) pushPrompt(p);
  });
  for (const p of tail) pushPrompt(p);
  return rows;
}
