import { useState } from 'react';
import { forgetName, rememberName } from '../../../sound/catalog.ts';
import { dropFileCache } from '../../../sound/files.ts';
import { getPrefsStore } from '../store.ts';
import type { ImportedFile } from '../ipc.ts';

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'That file could not be added.';
}

/** The "Your file..." flow: native picker, then `sound_import_file`. Errors name the limit. */
export function useFileImport() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(): Promise<ImportedFile | null> {
    const api = getPrefsStore().api;
    setError(null);
    setBusy(true);
    try {
      const path = await api.soundPickFile();
      if (!path) return null;
      const file = await api.soundImportFile(path);
      rememberName(file.id, file.name);
      return file;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, pick, clearError: () => setError(null) };
}

/** Delete a custom file in the backend and forget what the UI cached for it. */
export async function removeCustom(id: string): Promise<void> {
  await getPrefsStore().api.soundCustomRemove(id);
  dropFileCache(id);
  forgetName(id);
}
