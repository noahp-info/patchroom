import { useEffect } from 'react';

/**
 * The overlay registry. Every surface drawn over the app (Settings, Cmd+K, search, menus,
 * pickers, dialogs, the screenshot overlay) registers while it is open. The side-pane viewer is
 * a native view above all HTML, so while anything is registered the pane swaps it for a frozen
 * picture of itself. The store mirrors the count into `AppState.overlays`.
 */
const open = new Map<symbol, string>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of listeners) fn();
}

/** Register one open overlay. Call the returned function when it closes. */
export function openOverlay(name: string): () => void {
  const key = Symbol(name);
  open.set(key, name);
  changed();
  return () => {
    if (open.delete(key)) changed();
  };
}

/** How many overlays are open. */
export function overlayCount(): number {
  return open.size;
}

/** Names of the open overlays, for tests and debugging. */
export function overlayNames(): string[] {
  return [...open.values()];
}

export function subscribeOverlays(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Register while mounted (and `active`). */
export function useOverlay(name: string, active = true): void {
  useEffect(() => (active ? openOverlay(name) : undefined), [name, active]);
}
