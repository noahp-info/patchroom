import { createContext, useContext } from 'react';
import type { SectionId } from './registry.ts';

/** Lets a section open another place in Settings: a section, scrolled to one setting. */
export interface PrefsNav {
  /** Open `section` and, with `setting`, scroll to that row and flash it. */
  jump(section: SectionId, setting?: string): void;
}

export const PrefsNavContext = createContext<PrefsNav>({ jump: () => undefined });

export const usePrefsNav = (): PrefsNav => useContext(PrefsNavContext);
