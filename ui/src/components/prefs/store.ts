import { useSyncExternalStore } from 'react';
import {
  createPrefsApi,
  DEFAULT_PREFS,
  type HookDetect,
  type Prefs,
  type PrefsApi,
} from './ipc.ts';
import { setFontLister } from '../../theme/typeface.ts';

type Listener = () => void;

/**
 * One client-side copy of the prefs. Reads `prefs_get`, follows `prefs:changed`, writes through
 * `prefs_set`. Changes apply at once and the backend's answer replaces them.
 */
export class PrefsStore {
  private prefs: Prefs = DEFAULT_PREFS;
  private detected: HookDetect[] = [];
  private readonly listeners = new Set<Listener>();
  private started: Promise<void> | null = null;
  private off: (() => void) | null = null;
  private version = 0;
  private snap = { prefs: this.prefs, detected: this.detected, ready: false };

  constructor(readonly api: PrefsApi) {
    // The font pickers list installed families through the same backend.
    const list = api.fontsList?.bind(api);
    setFontLister(list ? () => list() : null);
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      this.off = await this.api.onPrefsChanged((p) => this.adopt(p)).catch(() => null);
      const [prefs, detected] = await Promise.all([
        this.api.prefsGet().catch(() => DEFAULT_PREFS),
        this.api.soundHooksDetect().catch(() => [] as HookDetect[]),
      ]);
      this.detected = detected;
      this.snap = { prefs, detected, ready: true };
      this.prefs = prefs;
      this.emit();
    })();
    return this.started;
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  private adopt(p: Prefs): void {
    this.prefs = p;
    this.snap = { prefs: p, detected: this.detected, ready: true };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  getSnapshot = () => this.snap;
  getPrefs = (): Prefs => this.prefs;
  getDetected = (): HookDetect[] => this.detected;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    void this.start();
    return () => void this.listeners.delete(l);
  };

  /** Merge a patch of top-level keys. Nested objects in the patch replace the old ones. */
  async update(patch: Partial<Prefs>): Promise<void> {
    const v = ++this.version;
    this.adopt({ ...this.prefs, ...patch });
    const saved = await this.api.prefsSet(patch);
    if (v === this.version) this.adopt(saved);
  }

  /** Open an http(s) link in the default browser (the person clicked it). */
  async openExternal(url: string): Promise<void> {
    if (!/^https:\/\//.test(url)) return;
    await this.api.linkOpenExternal?.(url);
  }

  async refreshDetected(): Promise<void> {
    this.detected = await this.api.soundHooksDetect().catch(() => []);
    this.snap = { ...this.snap, detected: this.detected };
    this.emit();
  }
}

let store: PrefsStore | null = null;

export function getPrefsStore(): PrefsStore {
  store ??= new PrefsStore(createPrefsApi());
  return store;
}

/** Swap the backend (tests, or the workspace once `ui/src/ipc` carries these commands). */
export function setPrefsApi(api: PrefsApi): PrefsStore {
  store?.stop();
  store = new PrefsStore(api);
  return store;
}

export function usePrefsState(): { prefs: Prefs; detected: HookDetect[]; ready: boolean } {
  const s = getPrefsStore();
  return useSyncExternalStore(s.subscribe, s.getSnapshot);
}

export function usePrefs(): Prefs {
  return usePrefsState().prefs;
}

/** Sound hooks that still play inside Patchroom sessions (detected, not yet guarded). */
export function unguardedSoundHooks(detected: readonly HookDetect[]): HookDetect[] {
  return detected.filter((h) => !h.guarded);
}

/** True while detection finds a sound hook that also plays in Patchroom sessions. */
export function useSoundHookOverlap(): boolean {
  const { detected, ready } = usePrefsState();
  return ready && unguardedSoundHooks(detected).length > 0;
}
