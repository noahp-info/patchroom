import type { SoundFileData } from '../components/prefs/ipc.ts';
import { getPrefsStore } from '../components/prefs/store.ts';
import { effectiveGain, FILE_BASE } from './gain.ts';
import { context } from './pack.ts';

/**
 * File sounds (CC0 packs, imported packs and the user's own files) play through an
 * HTMLAudioElement from the data URL that `sound_file` returns. Both the data and the element are
 * cached, so a second play does not touch the backend.
 *
 * `element.volume` stops at 1, and an event can go to 150%. So each element is routed through a
 * GainNode (MediaElementSource) that carries the whole level. Without Web Audio the element
 * volume is the fallback, capped at 1.
 */
const data = new Map<string, Promise<SoundFileData>>();
const elements = new Map<string, HTMLAudioElement>();
const nodes = new WeakMap<HTMLAudioElement, GainNode>();

/** A pack's sound is `<pack>/<event>`. A custom file is `custom:<id>/-`: one file, any event. */
const keyOf = (packId: string, event: string) => `${packId}/${event}`;
const customKey = (id: string) => keyOf(`custom:${id}`, '-');
const cacheKey = (packId: string, event: string) =>
  packId.startsWith('custom:') ? customKey(packId.slice(7)) : keyOf(packId, event);

/** The file data (data URL, normalizing gain, peak) for one sound. A failed fetch is not cached. */
export function fileData(packId: string, event: string): Promise<SoundFileData> {
  const key = cacheKey(packId, event);
  let p = data.get(key);
  if (!p) {
    const api = getPrefsStore().api;
    p = packId.startsWith('custom:')
      ? api.soundCustomFile(packId.slice(7))
      : api.soundFile(packId, event);
    data.set(key, p);
    p.catch(() => data.delete(key));
  }
  return p;
}

/** The data URL for one sound. */
export const fileDataUrl = (packId: string, event: string): Promise<string> =>
  fileData(packId, event).then((r) => r.dataUrl);

/** Forget what is cached for a pack or custom id (after a removal). */
export function dropFileCache(packId: string): void {
  for (const k of [...data.keys()]) {
    if (k.startsWith(`${packId}/`) || k.startsWith(`custom:${packId}/`)) {
      data.delete(k);
      elements.delete(k);
    }
  }
}

/** Resume a suspended context, but never wait on it for long (a webview may refuse). */
async function running(): Promise<AudioContext | null> {
  const c = context();
  if (c && c.state !== 'running') {
    await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 150))]);
  }
  return c && c.state === 'running' ? c : null;
}

/**
 * Play one file sound. `volume` is the master volume (0 to 1) and `gain` the event's gain
 * (0 to 1.5). The effective gain is master x event x the file's normalizing gain, held below
 * clipping by the file's peak. Resolves true once playback started, false when the file is
 * missing or the webview refused it.
 */
export async function playFile(
  packId: string,
  event: string,
  volume: number,
  gain = 1,
): Promise<boolean> {
  try {
    const key = cacheKey(packId, event);
    const file = await fileData(packId, event);
    const level = effectiveGain({
      master: volume,
      event: gain,
      norm: file.norm,
      base: FILE_BASE,
      peak: file.peak,
    });
    let el = elements.get(key);
    if (!el) {
      el = new Audio(file.dataUrl);
      el.preload = 'auto';
      elements.set(key, el);
    }
    let node = nodes.get(el);
    if (!node) {
      const c = await running();
      if (c) {
        node = c.createGain();
        node.gain.value = level;
        c.createMediaElementSource(el).connect(node);
        node.connect(c.destination);
        nodes.set(el, node);
      }
    }
    if (node) {
      node.gain.value = level;
      el.volume = 1;
    } else {
      el.volume = Math.min(1, level);
    }
    el.currentTime = 0;
    await el.play();
    return true;
  } catch {
    return false;
  }
}
