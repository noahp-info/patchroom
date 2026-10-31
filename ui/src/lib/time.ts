import type { Timestamp } from '../ipc';

/** Epoch milliseconds from a wire timestamp (ms, seconds or ISO text). 0 when unreadable. */
export function toMillis(ts: Timestamp | undefined): number {
  if (typeof ts === 'number') return ts < 1e11 ? ts * 1000 : ts;
  if (typeof ts === 'string') {
    const n = Date.parse(ts);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

export function formatClock(ms: number): string {
  return ms ? clock.format(ms) : '';
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday" or a long date. */
export function formatDay(ms: number, now = Date.now()): string {
  if (!ms) return '';
  if (dayKey(ms) === dayKey(now)) return 'Today';
  if (dayKey(ms) === dayKey(now - 86_400_000)) return 'Yesterday';
  return day.format(ms);
}

/** "Today 2:40 PM" or "Tuesday, October 13 2:40 PM". */
export function formatStamp(ms: number, now = Date.now()): string {
  if (!ms) return '';
  return `${formatDay(ms, now)} ${formatClock(ms)}`;
}
