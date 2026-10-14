import type { Page } from '@playwright/test';
import type { PrefsApi } from '../src/components/prefs/ipc';
import type { Prefs } from '../src/components/prefs/ipc';
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
  dndActive(dnd: Prefs['dnd'], now?: Date): boolean;
  dndSummary(s: Prefs['dnd']['schedule']): string;
  soundLog: SoundLogEntry[];
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
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  await page.waitForFunction(() => window.__PR_PREFS__.store.getPrefs() !== undefined);
}

export async function tab(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Preferences sections' })
    .getByRole('button', { name, exact: true })
    .click();
}

export const root = (page: Page) => page.locator('.pr-app');

/** What the audio spy saw: oscillators, low-pass filters and file playbacks (src prefix, volume). */
export interface AudioSpy {
  osc: number;
  lowpass: number;
  files: { src: string; volume: number }[];
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
    const spy = { osc: 0, lowpass: 0, files: [] as { src: string; volume: number }[] };
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
    HTMLAudioElement.prototype.play = function (this: HTMLAudioElement) {
      spy.files.push({ src: this.src, volume: this.volume });
      return Promise.resolve();
    };
  });
}

export const audio = (page: Page) => page.evaluate(() => structuredClone(window.__AUDIO__));
export const resetAudio = (page: Page) =>
  page.evaluate(() => {
    window.__AUDIO__.osc = 0;
    window.__AUDIO__.lowpass = 0;
    window.__AUDIO__.files.length = 0;
  });
