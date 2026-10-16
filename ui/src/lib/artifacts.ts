import type { ChatItem } from '../ipc';
import { itemText } from './itemText';

/** A published claude.ai artifact link. */
const ARTIFACT = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

/** The first artifact link in an item: its text, or a tool's result. */
export function artifactUrlOf(it: ChatItem): string | null {
  const text = it.kind === 'tool' ? `${itemText(it)}\n${it.result?.text ?? ''}` : itemText(it);
  return ARTIFACT.exec(text)?.[0] ?? null;
}

const KEY = 'patchroom.artifacts';
/** Per DM item: its artifact link, and whether it was pinned automatically once. */
type Entry = { url: string; autopinned: boolean };
type Registry = Record<string, Entry>;
const id = (dm: string, itemKey: string) => `${dm}\u0000${itemKey}`;

function read(): Registry {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Registry) : {};
  } catch {
    return {};
  }
}
function write(r: Registry): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // Blocked storage: artifacts are found again from the transcript.
  }
}

/** The artifact link recorded for a DM item, for the Pins list. */
export function artifactUrlFor(dm: string, itemKey: string): string | null {
  return read()[id(dm, itemKey)]?.url ?? null;
}

/**
 * Record the artifacts in `items`. Returns the item keys to pin now: each artifact is pinned
 * once, so an unpin sticks. `autoPin` off records links without pinning.
 */
export function noteArtifacts(dm: string, items: ChatItem[], autoPin: boolean): string[] {
  const reg = read();
  const pin: string[] = [];
  let changed = false;
  for (const it of items) {
    if (it.parentToolUseId) continue;
    const url = artifactUrlOf(it);
    if (!url) continue;
    const k = id(dm, it.key);
    const had = reg[k];
    if (!had || had.url !== url) {
      reg[k] = { url, autopinned: had?.autopinned ?? false };
      changed = true;
    }
    if (autoPin && !reg[k].autopinned) {
      reg[k] = { ...reg[k], autopinned: true };
      pin.push(it.key);
      changed = true;
    }
  }
  if (changed) write(reg);
  return pin;
}
