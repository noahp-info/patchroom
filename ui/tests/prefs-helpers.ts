import type { Page } from '@playwright/test';
import type { PrefsApi } from '../src/components/prefs/ipc';
import type { Prefs } from '../src/components/prefs/ipc';
import type { SoundDecision, SoundLogEntry } from '../src/sound';

export const HARNESS = '/src/components/prefs/harness.html';

interface Hooks {
  store: {
    getPrefs(): Prefs;
    update(patch: Partial<Prefs>): Promise<void>;
  };
  api: PrefsApi & { notifyTests: number };
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
