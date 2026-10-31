import type { Page } from '@playwright/test';
import type { PrefsApi } from '../src/components/prefs/ipc';
import type { HookDetect, Prefs } from '../src/components/prefs/ipc';
import type { SoundDecision, SoundLogEntry } from '../src/sound';
import type { MockSoundBackend } from '../src/ipc/mockSounds';

export const HARNESS = '/src/components/prefs/harness.html';

interface Hooks {
  store: {
    getPrefs(): Prefs;
    update(patch: Partial<Prefs>): Promise<void>;
  };
  api: PrefsApi & { notifyTests: number; sound: MockSoundBackend };
  playSound(event: string, opts?: Record<string, unknown>): SoundDecision;
  decideSound(
    event: string,
    prefs: Prefs,
    detected: readonly HookDetect[],
    ctx?: { dmId?: string; now?: Date; force?: boolean },
  ): SoundDecision;
  eventsForHook(hookEvent: string): string[];
  hookKeepsEvent(
    event: string,
    detected: readonly HookDetect[],
    policy: Prefs['sound']['hookPolicy'],
  ): boolean;
  resolveChoice(event: string, sound: Prefs['sound'], dmId?: string): unknown;
  dndActive(dnd: Prefs['dnd'], now?: Date): boolean;
  dndSummary(s: Prefs['dnd']['schedule']): string;
  soundLog: SoundLogEntry[];
  effectiveGain(i: {
    master: number;
    event: number;
    norm?: number;
    base: number;
    peak?: number;
  }): number;
  generated: Record<string, { notes: Record<string, unknown[]> }>;
  notesPeak(notes: unknown[]): number;
  fakeTerm: { options: { theme?: Record<string, string>; fontFamily?: string; fontSize?: number } };
}
declare global {
  interface Window {
    __PR_PREFS__: Hooks;
  }
}

/** Open the harness on a fresh mock backend. `query` adds `hooks=Stop` and similar. */
export async function openPrefs(page: Page, query = ''): Promise<void> {
  await page.goto(`${HARNESS}?fresh&${query}`);
  await page.getByRole('dialog', { name: 'Settings' }).waitFor();
  await page.waitForFunction(() => window.__PR_PREFS__.store.getPrefs() !== undefined);
}

export async function tab(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name, exact: true })
    .click();
}

export const root = (page: Page) => page.locator('.pr-app');

/**
 * What the audio spy saw: oscillators, low-pass filters, the master gain each oscillator sound
 * played at (`levels`), and every file playback (src, element volume, whether it is routed through
 * a GainNode, and that node's gain at play time, which is the level the speakers get).
 */
export interface AudioSpy {
  osc: number;
  lowpass: number;
  levels: number[];
  files: { src: string; volume: number; routed: boolean; gain: number }[];
}
declare global {
  interface Window {
    __AUDIO__: AudioSpy;
  }
}

/**
 * Count Web Audio oscillators and low-pass filters, and record every HTMLAudioElement.play.
 * Call before `openPrefs`. Nothing reaches the speakers.
 */
export async function spyAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy: AudioSpy = { osc: 0, lowpass: 0, levels: [], files: [] };
    window.__AUDIO__ = spy;
    const proto = AudioContext.prototype;
    const osc = proto.createOscillator;
    proto.createOscillator = function (this: AudioContext) {
      spy.osc += 1;
      return osc.call(this);
    };
    const bq = proto.createBiquadFilter;
    proto.createBiquadFilter = function (this: AudioContext) {
      const f = bq.call(this);
      spy.lowpass += 1;
      return f;
    };
    // Which GainNode carries each element, and which gain nodes are an element's (not oscillators').
    const carrier = new WeakMap<HTMLMediaElement, GainNode>();
    const mediaGains = new WeakSet<GainNode>();
    const connect = AudioNode.prototype.connect as (
      this: AudioNode,
      ...a: unknown[]
    ) => AudioNode | void;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
      const dest = args[0];
      if (this instanceof MediaElementAudioSourceNode && dest instanceof GainNode) {
        carrier.set(this.mediaElement, dest);
        mediaGains.add(dest);
      } else if (
        this instanceof GainNode &&
        dest instanceof AudioDestinationNode &&
        !mediaGains.has(this)
      ) {
        spy.levels.push(this.gain.value);
      }
      return connect.apply(this, args);
    } as typeof AudioNode.prototype.connect;
    HTMLAudioElement.prototype.play = function (this: HTMLAudioElement) {
      const node = carrier.get(this);
      spy.files.push({
        src: this.src,
        volume: this.volume,
        routed: !!node,
        gain: node ? node.gain.value : this.volume,
      });
      return Promise.resolve();
    };
  });
}

export const audio = (page: Page) => page.evaluate(() => structuredClone(window.__AUDIO__));
export const resetAudio = (page: Page) =>
  page.evaluate(() => {
    window.__AUDIO__.osc = 0;
    window.__AUDIO__.lowpass = 0;
    window.__AUDIO__.levels.length = 0;
    window.__AUDIO__.files.length = 0;
  });
