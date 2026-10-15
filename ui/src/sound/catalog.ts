import { useSyncExternalStore } from 'react';
import type { ClaudeProfile, PackInfo, PrefsApi } from '../components/prefs/ipc.ts';
import { getPrefsStore } from '../components/prefs/store.ts';

/**
 * The pack list (`sound_packs`), the Claude profiles and the names of the user's own files.
 * Packs and the user's file names load once per backend and refresh after an import.
 */
interface Snap {
  packs: PackInfo[];
  profiles: ClaudeProfile[];
  loaded: boolean;
  names: Record<string, string>;
}

const listeners = new Set<() => void>();
let snap: Snap = { packs: [], profiles: [], loaded: false, names: {} };
let loading: Promise<void> | null = null;
let loadedFor: PrefsApi | null = null;

function emit(next: Partial<Snap>): void {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

/** Normalize `events`, which may arrive as a list or as a map of event to true. */
function profileEvents(raw: unknown): ClaudeProfile['events'] {
  if (Array.isArray(raw)) return raw as ClaudeProfile['events'];
  if (raw && typeof raw === 'object') {
    return Object.keys(raw).filter(
      (k) => (raw as Record<string, unknown>)[k],
    ) as ClaudeProfile['events'];
  }
  return [];
}

export function refreshPacks(): Promise<void> {
  const api = getPrefsStore().api;
  return api
    .soundPacks()
    .then((packs) => emit({ packs, loaded: true }))
    .catch(() => emit({ loaded: true }));
}

export function refreshProfiles(): Promise<void> {
  const api = getPrefsStore().api;
  return api
    .soundClaudeProfiles()
    .then((rows) =>
      emit({ profiles: rows.map((r) => ({ ...r, events: profileEvents(r.events) })) }),
    )
    .catch(() => emit({ profiles: [] }));
}

/** Load the pack list once per backend. Profiles load only when the user asks to import. */
/** The user's own sounds, for their display names. */
export function refreshCustom(): Promise<void> {
  return getPrefsStore()
    .api.soundCustomList()
    .then((rows) => emit({ names: Object.fromEntries(rows.map((r) => [r.id, r.name])) }))
    .catch(() => undefined);
}

export function loadCatalog(): Promise<void> {
  const api = getPrefsStore().api;
  if (loadedFor !== api) {
    loadedFor = api;
    snap = { ...snap, packs: [], profiles: [], loaded: false };
    loading = null;
  }
  loading ??= Promise.all([refreshPacks(), refreshCustom()]).then(() => undefined);
  return loading;
}

/** A file the backend just added: show its name at once. */
export function rememberName(id: string, name: string): void {
  emit({ names: { ...snap.names, [id]: name } });
}

export function forgetName(id: string): void {
  const names = { ...snap.names };
  delete names[id];
  emit({ names });
}

export const customLabel = (names: Record<string, string>, id: string): string =>
  names[id] ? `Your file: ${names[id]}` : 'Your file';

export function useCatalog(): Snap {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      void loadCatalog();
      return () => void listeners.delete(l);
    },
    () => snap,
  );
}
