import type { TokenKey } from './tokens.ts';

export type ThemeMode = 'light' | 'dark';
export type TokenMap = Record<TokenKey, string>;

/** A color theme: a complete token set for light and for dark. Colors only. */
export interface Theme {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  author?: string;
  license?: string;
  modes: Record<ThemeMode, TokenMap>;
}

export type BaseId = 'homeroom' | 'patchbay' | 'scrollback' | 'bluepencil';

export interface BaseInfo {
  id: BaseId;
  name: string;
  tagline: string;
  /** `stub` bases define dimensions, type and radii only and render on the shared chrome. */
  status: 'ready' | 'stub';
  /** Elements only this base draws. */
  baseOnly: readonly string[];
}
