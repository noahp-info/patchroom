import { useState } from 'react';
import { refreshPacks, refreshProfiles, useCatalog } from '../../../sound/catalog.ts';
import { getPrefsStore } from '../store.ts';
import { errorText } from './useFileImport.ts';

/** "Import your Claude sounds": lists the Claude Code sound profiles (read only), imports one. */
export function ClaudeImport() {
  const { profiles, packs } = useCatalog();
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function show() {
    setBusy(true);
    setError(null);
    await refreshProfiles();
    setShown(true);
    setBusy(false);
  }

  async function importProfile(id: string, name: string) {
    setError(null);
    setDone(null);
    try {
      await getPrefsStore().api.soundImportClaudeProfile(id);
      await refreshPacks();
      setDone(`Imported ${name}. It is now a pack above.`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="cimp" data-testid="claude-import">
      <p className="pf-hint">
        Reads your Claude Code sound profiles and never changes them. Importing copies the audio
        files into Patchroom.
      </p>
      <button type="button" className="btn sec" disabled={busy} onClick={() => void show()}>
        Import your Claude sounds
      </button>
      {shown && profiles.length === 0 && (
        <p className="pf-hint" role="status">
          No Claude sound profiles found.
        </p>
      )}
      {shown && profiles.length > 0 && (
        <ul className="plist" aria-label="Claude sound profiles">
          {profiles.map((p) => {
            const have = packs.some((k) => k.kind === 'imported' && k.id.endsWith(p.id));
            return (
              <li key={p.id}>
                <span className="plist__name">
                  {p.name}
                  <small className="pf-hint">
                    {' '}
                    {p.events.length} {p.events.length === 1 ? 'sound' : 'sounds'}
                  </small>
                </span>
                <button
                  type="button"
                  className="btn sec"
                  aria-label={`Import ${p.name} profile`}
                  disabled={have}
                  onClick={() => void importProfile(p.id, p.name)}
                >
                  {have ? 'Imported' : 'Import'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {done && (
        <p className="pf-ok" role="status">
          {done}
        </p>
      )}
      {error && (
        <p className="pf-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
