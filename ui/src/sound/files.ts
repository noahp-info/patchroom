import { getPrefsStore } from '../components/prefs/store.ts';

/**
 * File sounds (CC0 packs, imported packs and the user's own files) play through an
 * HTMLAudioElement from the data URL that `sound_file` returns. Both the URL and the element are
 * cached, so a second play does not touch the backend.
 */
const urls = new Map<string, Promise<string>>();
const elements = new Map<string, HTMLAudioElement>();

/** A pack's sound is `<pack>/<event>`. A custom file is `custom:<id>/-`: one file, any event. */
const keyOf = (packId: string, event: string) => `${packId}/${event}`;
const customKey = (id: string) => keyOf(`custom:${id}`, '-');

/** The data URL for one sound. A failed fetch is not cached. */
export function fileDataUrl(packId: string, event: string): Promise<string> {
  const key = packId.startsWith('custom:') ? customKey(packId.slice(7)) : keyOf(packId, event);
  let p = urls.get(key);
  if (!p) {
    const api = getPrefsStore().api;
    const req = packId.startsWith('custom:')
      ? api.soundCustomFile(packId.slice(7))
      : api.soundFile(packId, event);
    p = req.then((r) => r.dataUrl);
    urls.set(key, p);
    p.catch(() => urls.delete(key));
  }
  return p;
}

/** Forget what is cached for a pack or custom id (after a removal). */
export function dropFileCache(packId: string): void {
  for (const k of [...urls.keys()]) {
    if (k.startsWith(`${packId}/`) || k.startsWith(`custom:${packId}/`)) {
      urls.delete(k);
      elements.delete(k);
    }
  }
}

/**
 * Play one file sound at `volume` (0 to 1). Resolves true once playback started, false when the
 * file is missing or the webview refused it.
 */
export async function playFile(packId: string, event: string, volume: number): Promise<boolean> {
  try {
    const key = packId.startsWith('custom:') ? customKey(packId.slice(7)) : keyOf(packId, event);
    const url = await fileDataUrl(packId, event);
    let el = elements.get(key);
    if (!el) {
      el = new Audio(url);
      el.preload = 'auto';
      elements.set(key, el);
    }
    el.volume = Math.min(1, Math.max(0, volume));
    el.currentTime = 0;
    await el.play();
    return true;
  } catch {
    return false;
  }
}
