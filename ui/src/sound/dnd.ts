import type { DndSchedule, Prefs } from '../components/prefs/ipc.ts';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

/** "HH:MM" to minutes after midnight, or null when malformed. */
export function parseHm(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** A schedule that can silence something: valid times, at least one day, start differs from end. */
export function scheduleIsUsable(s: DndSchedule | null): s is DndSchedule {
  if (!s || s.days.length === 0) return false;
  const a = parseHm(s.start);
  const b = parseHm(s.end);
  return a !== null && b !== null && a !== b;
}

/** True when the schedule crosses midnight (start is later than end). */
export function crossesMidnight(s: DndSchedule): boolean {
  const a = parseHm(s.start);
  const b = parseHm(s.end);
  return a !== null && b !== null && a > b;
}

/**
 * Is `now` inside the scheduled window? A window belongs to the day it starts on, so a Friday
 * 22:00 to 08:00 window is still on at 03:00 Saturday.
 */
export function scheduleActive(s: DndSchedule | null, now: Date): boolean {
  if (!scheduleIsUsable(s)) return false;
  const start = parseHm(s.start)!;
  const end = parseHm(s.end)!;
  const mins = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  if (start < end) return s.days.includes(day) && mins >= start && mins < end;
  return (s.days.includes(day) && mins >= start) || (s.days.includes((day + 6) % 7) && mins < end);
}

/** Do Not Disturb is on: the manual toggle, or inside the schedule. */
export function dndActive(dnd: Prefs['dnd'], now: Date = new Date()): boolean {
  return dnd.manual || scheduleActive(dnd.schedule, now);
}

function sameDays(a: number[], b: number[]): boolean {
  const x = [...new Set(a)].sort();
  return x.length === b.length && x.every((d, i) => d === b[i]);
}

/** Plain-language summary, for example "Weeknights 22:00 to 08:00". */
export function dndSummary(s: DndSchedule | null): string {
  if (!s || s.days.length === 0) return 'No days selected, so nothing is silenced.';
  const a = parseHm(s.start);
  const b = parseHm(s.end);
  if (a === null || b === null) return 'Enter the start and end as HH:MM.';
  if (a === b) return 'Start and end are the same, so nothing is silenced.';
  const night = a > b;
  const days = [...new Set(s.days)].sort();
  let label: string;
  if (days.length === 7) label = night ? 'Every night' : 'Every day';
  else if (sameDays(days, WEEKDAYS)) label = night ? 'Weeknights' : 'Weekdays';
  else if (sameDays(days, WEEKEND)) label = night ? 'Weekend nights' : 'Weekends';
  else {
    const names = days.map((d) => DAY_NAMES[d]).join(', ');
    label = night ? `${names} nights` : names;
  }
  return `${label} ${s.start} to ${s.end}`;
}
